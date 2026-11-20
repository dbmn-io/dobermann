// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/* DBMN Hub — tab state + strip renderer
 *
 * Owns the in-Hub tab system that lives in column 3. Tabs key on `type:refId`
 * so opening the same endpoint twice focuses the existing tab. A single
 * "preview" slot tracks the italic tab created by single-clicking a list
 * row — promoting to kept (double-click, edit, run, type) clears the slot
 * so the next preview can reuse it without piling up entries.
 *
 * Wire-up: hub.js calls `HubTabs.init()` after DOM ready; catalogue / other
 * sections call `HubTabs.openOrFocusTab(spec)` instead of posting their own
 * messages. The renderer drives `.hub-layout.has-tabs` so column 3 reveals.
 */
(function () {
    'use strict';

    /** @typedef {{
     *   id: string,
     *   type: 'endpoint' | 'environment' | 'console' | 'batch' | 'page',
     *   refId: string,
     *   name: string,
     *   preview: boolean,
     *   dirty: boolean,
     *   status?: 'queued' | 'running' | 'done' | 'failed',
     *   progress?: { done: number; total: number }
     * }} Tab
     */

    const TYPE_GLYPH = {
        endpoint:     'notebook-tabs',
        environment:  'server',
        console:      'play',
        batchConsole: 'folder-tree-play',
        batch:        'folder-tree-play',
        compare:      'scale',
        lookup:       'sheet',
        design:       'layers',
        logs:         'scroll-text',
        page:         'settings'
    };

    /** The saved queries that are compares (a join set to Compare): their tabs wear Compare's icon, as the Reporting list does. */
    let compareQueries = new Set();
    /** The Hub's saved queries came (again): a tab whose query became a compare, or stopped being one, changes its icon. */
    function setQueries(queries) {
        const next = new Set((queries || []).filter(q => (q.joins || []).some(j => j && j.kind === 'compare')).map(q => q.id));
        const same = next.size === compareQueries.size && [...next].every(id => compareQueries.has(id));
        compareQueries = next;
        if (!same && state.tabs.some(t => t.type === 'compare')) renderStrip();
    }

    /** Page tabs (GitHub Issue #292) — hub-native tabs whose body is one of
     *  the page-style sections from hub.html (Settings / Account / Import /
     *  Export). The glyph mirrors the rail icon for the same section. */
    const PAGE_GLYPH = {
        settings: 'settings',
        account:  'user',
        import:   'download',
        export:   'upload'
    };

    /** Tab types that show a status icon (queued / running / done / failed
     *  / paused / stopped) + live progress bar. Both single-call Console
     *  and batch Console get the affordance — the underlying execution
     *  lifecycle is the same. */
    const STATUS_TYPES = new Set(['console', 'batchConsole']);

    /** Statuses that keep the per-tab progress label + bar visible. The count
     *  (e.g. 12/12) now PERSISTS through terminal states too, so a user who
     *  navigates away can glance at the tab and see the final tally. Colour-
     *  coded per status (see CSS): green=running/completed, yellow=paused,
     *  red=stopped/failed. */
    /** #438: a tab status's fill colour in the Console footer's terms (core.css .progress-bar-fill.*) */
    /** #438: a tab's status as the Console footer names it, for the footer's colour. */
    const FOOTER_STATUS = { running: 'running', paused: 'paused', stopped: 'stopped', cancelled: 'stopped', completed: 'completed', done: 'completed', failed: 'error', error: 'error', partial: 'error' };

    /**
     * #438: the colour a console tab is drawn in (FOOTER_STATUS), or '' for none. The tab's Console
     * gets the same (hubTabColour, below), so its heading is always the tab's colour.
     */
    function tabColourOf(tab) {
        if (!STATUS_TYPES.has(tab.type) || !PROGRESS_STATUSES.has(tab.status) || !tab.progress || !(tab.progress.total > 0)) return '';
        return FOOTER_STATUS[tab.status] || tab.status;
    }

    function progressPercent(progress) {
        return Math.max(0, Math.min(100, Math.round((progress.done / progress.total) * 100)));
    }

    const PROGRESS_STATUSES = new Set([
        'running', 'paused', 'stopped', 'cancelled',
        'completed', 'done', 'failed', 'error', 'partial'
    ]);

const state = {
        /** @type {Tab[]} */
        tabs: [],
        /** @type {string | null} */
        activeTabId: null,
        /** @type {string | null} */
        previewTabId: null
    };

    /** Listeners notified after any state change so they can render. */
    const listeners = new Set();

    function emit() {
        listeners.forEach(fn => { try { fn(state); } catch (_e) { /* swallow */ } });
    }

    function makeTabId(type, refId) {
        return `${type}:${refId}`;
    }

    function findTab(id) {
        return state.tabs.find(t => t.id === id) || null;
    }

    function findIndex(id) {
        return state.tabs.findIndex(t => t.id === id);
    }

    /** Open a tab or focus the existing one for the same type+refId.
     *  If `spec.preview` is true, the new tab replaces the current preview
     *  slot (one preview at a time). Returns the resulting tab. */
    function openOrFocusTab(spec) {
        // Allow callers to pass an explicit `id` (used by singleton-mounted
        // managers: 'endpoint', 'environment', 'batch'). Falls back to the
        // composed `type:refId` key for the default case (e.g. Console with
        // one tab per run).
        const id = spec.id || makeTabId(spec.type, spec.refId);
        const existing = findTab(id);

        if (existing) {
            // Already open — focus and (if it was the preview) optionally
            // promote to kept based on `spec.preview === false`.
            if (spec.preview === false && existing.preview) {
                existing.preview = false;
                if (state.previewTabId === id) state.previewTabId = null;
            }
            // Update name if caller has a fresher one (e.g. after a save).
            if (spec.name && spec.name !== existing.name) {
                existing.name = spec.name;
            }
            state.activeTabId = id;
            emit();
            return existing;
        }

        const tab = {
            id,
            type: spec.type,
            refId: spec.refId,
            name: spec.name || spec.refId,
            preview: !!spec.preview,
            dirty: false
        };

        if (tab.preview && state.previewTabId) {
            // Replace the existing preview tab in-place so the slot doesn't
            // accumulate dead italic tabs as the user browses.
            const prevIdx = findIndex(state.previewTabId);
            if (prevIdx !== -1) {
                state.tabs.splice(prevIdx, 1, tab);
            } else {
                state.tabs.push(tab);
            }
            state.previewTabId = id;
        } else {
            state.tabs.push(tab);
            if (tab.preview) state.previewTabId = id;
        }

        state.activeTabId = id;
        emit();
        return tab;
    }

    function focusTab(id) {
        if (!findTab(id)) return;
        state.activeTabId = id;
        emit();
    }

    /** Remove a tab. If it was active, the neighbour to the left becomes
     *  active (or to the right if it was the leftmost). Returns true if
     *  the tab existed and was removed. */
    function closeTab(id) {
        const idx = findIndex(id);
        if (idx === -1) return false;

        state.tabs.splice(idx, 1);
        if (state.previewTabId === id) state.previewTabId = null;

        if (state.activeTabId === id) {
            if (state.tabs.length === 0) {
                state.activeTabId = null;
            } else {
                const nextIdx = Math.min(idx, state.tabs.length - 1);
                state.activeTabId = state.tabs[nextIdx].id;
            }
        }
        emit();
        return true;
    }

    function markDirty(id, dirty) {
        const tab = findTab(id);
        if (!tab) return;
        if (tab.dirty === !!dirty) return;
        tab.dirty = !!dirty;
        // Editing a preview tab implicitly promotes it to kept — the user is
        // committing to the slot.
        if (tab.dirty && tab.preview) {
            tab.preview = false;
            if (state.previewTabId === id) state.previewTabId = null;
        }
        emit();
    }

    function promotePreviewToKept(id) {
        const tab = findTab(id);
        if (!tab || !tab.preview) return;
        tab.preview = false;
        if (state.previewTabId === id) state.previewTabId = null;
        emit();
    }

    /** Console-only — update run status + progress on a tab. */
    function setStatus(id, status, progress) {
        const tab = findTab(id);
        if (!tab) return;
        // Only overwrite fields that were actually provided. A status-only
        // push (e.g. tab mount) must not wipe live progress, and a
        // progress-only push must not clear the status — otherwise the
        // progress bar flickers off between updates.
        const statusChanged = status !== undefined && status !== null && status !== tab.status;
        const progressChanged = progress !== undefined
            && (!tab.progress || tab.progress.done !== progress.done || tab.progress.total !== progress.total);
        if (!statusChanged && !progressChanged) return;
        if (status !== undefined && status !== null) tab.status = status;
        if (progress !== undefined) tab.progress = progress;
        // Issue #312: a progress tick patches its own tab in place. It used to
        // emit() — a full strip rebuild (every tab element, icons, scroll
        // measurement) plus a snapshot post to the host — for EVERY progress
        // message, a few dozen a second with a batch on 8 threads. That kept
        // the Hub's renderer busy enough that a Console iframe took three
        // seconds to boot beside it, and the stream behind it crawled.
        if (!statusChanged && patchTabProgress(tab)) return;
        emit();
    }

    /** Update one tab's progress label and bar in the DOM. False when the tab
     *  has no such nodes yet (first progress for it) — the caller rebuilds. */
    function patchTabProgress(tab) {
        if (typeof document === 'undefined' || !document.getElementById) return false;
        const strip = document.getElementById('hubTabStrip');
        if (!strip || !tab.progress) return false;
        // Found by dataset, not a selector — tab ids carry ':' and other characters
        const el = Array.from(strip.children).find(c => c.dataset && c.dataset.tabId === tab.id);
        if (!el) return false;
        const label = el.querySelector('.hub-tab-progress-label');
        const bar = el.querySelector('.hub-tab-progress');
        if (!label || !bar) return false;
        label.textContent = `${tab.progress.done}/${tab.progress.total}`;
        if (tab.progress.total > 0) el.style.setProperty('--tab-progress', `${progressPercent(tab.progress)}%`);
        return true;
    }

    /** Move the tab at `id` to position `newIndex` (clamped). */
    function reorderTab(id, newIndex) {
        const fromIdx = findIndex(id);
        if (fromIdx === -1) return;
        const clamped = Math.max(0, Math.min(state.tabs.length - 1, newIndex));
        if (clamped === fromIdx) return;
        const [tab] = state.tabs.splice(fromIdx, 1);
        state.tabs.splice(clamped, 0, tab);
        emit();
    }

    function getState() {
        return state;
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    /* ─── Renderer ─────────────────────────────────────────────────────── */

    function renderStrip() {
        const strip = document.getElementById('hubTabStrip');
        const layout = document.querySelector('.hub-layout');
        if (!strip || !layout) return;

        // Toggle column 3 visibility. The grid template + display:none in
        // hub.css collapse the column entirely when no tabs are open.
        layout.classList.toggle('has-tabs', state.tabs.length > 0);

        // Strip contains only tabs now — chevrons + Close all live in
        // the wrapper as siblings of the strip (see init()).
        strip.innerHTML = '';
        for (const tab of state.tabs) {
            strip.appendChild(buildTabElement(tab));
        }
        if (window.Icons) window.Icons.injectIcons(strip);

        // Close all is only worth its own affordance at 2+ tabs — with
        // 0/1 the per-tab × already covers it. Chevrons show/hide via
        // data-can-scroll-* attrs the CSS keys off (see computeScrollAffordances).
        const closeAll = document.querySelector('.hub-tab-strip-close-all');
        if (closeAll) {
            closeAll.style.display = state.tabs.length >= 2 ? 'flex' : 'none';
        }

        sendTabColours();

        // Update chevron visibility for the new layout, and nudge the
        // active tab into view if it just changed.
        computeScrollAffordances();
        scrollActiveIntoView();
    }

    function buildScrollChevron(dir) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `hub-tab-strip-chev hub-tab-strip-chev--${dir}`;
        btn.setAttribute('aria-label', dir === 'left' ? 'Scroll tabs left' : 'Scroll tabs right');
        btn.title = dir === 'left' ? 'Scroll left' : 'Scroll right';
        btn.dataset.action = dir === 'left' ? 'scroll-left' : 'scroll-right';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.setAttribute('data-icon', dir === 'left' ? 'circle-chevron-left' : 'circle-chevron-right');
        btn.appendChild(icon);
        return btn;
    }

    function buildCloseAllButton() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hub-tab-strip-close-all';
        btn.setAttribute('aria-label', 'Close all tabs');
        btn.title = 'Close all tabs';
        btn.dataset.action = 'close-all';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.setAttribute('data-icon', 'tab-x');
        btn.appendChild(icon);
        return btn;
    }

    /** Toggle data-can-scroll-left / -right on the strip so the chevron
     *  CSS shows/hides each button. Called on scroll, on strip resize,
     *  and after every renderStrip(). */
    function computeScrollAffordances() {
        const strip = document.getElementById('hubTabStrip');
        if (!strip) return;
        const canLeft = strip.scrollLeft > 0;
        // -1 tolerance for sub-pixel rounding at the extreme right edge.
        const canRight = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
        strip.dataset.canScrollLeft = canLeft ? 'true' : 'false';
        strip.dataset.canScrollRight = canRight ? 'true' : 'false';
    }

    let lastScrolledActiveId = null;
    /** Bring the active tab into view if it changed since the last
     *  render. Guarded so unrelated re-renders (dirty toggle, progress
     *  tick, name change) don't nudge the scroll. */
    function scrollActiveIntoView() {
        if (state.activeTabId === lastScrolledActiveId) return;
        lastScrolledActiveId = state.activeTabId;
        if (!state.activeTabId) return;
        const strip = document.getElementById('hubTabStrip');
        if (!strip) return;
        const el = strip.querySelector(`.hub-tab[data-tab-id="${cssEscape(state.activeTabId)}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    /** Bulk-close every clean tab after a single confirm. Tabs with
     *  unsaved work are kept open — an edited endpoint or environment, or
     *  a Run Batch holding data it hasn't run (Issue #348). Consoles close:
     *  they hold no state, a running batch carries on, and History reopens
     *  them. The action is non-destructive by design, so no per-tab
     *  discard prompts. Reopening is a one-
     *  click round-trip through the Hub menus, and the dirty-tab list
     *  in the confirm body makes it obvious what stays behind. */
    function closeAllTabs() {
        if (state.tabs.length === 0) return;
        const dirty = state.tabs.filter(t => t.dirty);
        const closable = state.tabs.filter(t => !t.dirty);

        // Every open tab has unsaved changes — nothing safe to close.
        if (closable.length === 0) {
            const msg = state.tabs.length === 1
                ? 'The only open tab has unsaved changes — save it or close it individually.'
                : `All ${state.tabs.length} open tabs have unsaved changes. Save them, or close them individually.`;
            if (window.DbmnModal?.alert) {
                window.DbmnModal.alert({ title: 'Nothing to close', body: msg });
            } else if (window.DbmnModal?.show) {
                window.DbmnModal.show({
                    title: 'Nothing to close',
                    body: msg,
                    actions: [{ id: 'ok', label: 'OK', variant: 'primary' }],
                    dismissible: true
                });
            }
            return;
        }

        const closableCount = closable.length;
        const closableWord = closableCount === 1 ? 'tab' : 'tabs';
        let body = `${closableCount} ${closableWord} will be closed.`;
        if (dirty.length > 0) {
            const shown = dirty.slice(0, 5).map(t => `"${t.name}"`).join(', ');
            const extra = dirty.length > 5 ? `, and ${dirty.length - 5} more` : '';
            const dirtyPhrase = dirty.length === 1
                ? '1 tab with unsaved work will stay open'
                : `${dirty.length} tabs with unsaved work will stay open`;
            body += ` ${dirtyPhrase}: ${shown}${extra}.`;
        }

        if (!window.DbmnModal?.confirm) {
            // eslint-disable-next-line no-alert
            if (window.confirm(`${body}\n\nContinue?`)) performCloseAll();
            return;
        }
        window.DbmnModal.confirm({
            title: 'Close all tabs?',
            body,
            confirmLabel: 'Close',
            cancelLabel: 'Cancel'
        }).then((ok) => {
            if (ok) performCloseAll();
        });
    }

    function performCloseAll() {
        // Only close clean tabs — keep unsaved work open. Snapshot ids
        // first because performClose mutates state.tabs.
        const ids = state.tabs.filter(t => !t.dirty).map(t => t.id);
        for (const id of ids) performClose(id);
    }

    /**
     * Names. A tab shows its screen's name; it is not where a name is changed (James, 2026-11-19: a
     * pencil on some tabs only would be inconsistent). Rename is in the Hub's lists, by right-click,
     * for every kind of thing (reports, endpoints, environments, runs): this one dialog. A query and
     * a compare also show their name on their own screen, where a click renames it (dbmn-name).
     * Run Batch's tab shows the batch's name (its screen tells it: __tabName__).
     */
    const NAME_MAX = { compare: 30, batch: 100 };
    function canRename(tab) { return !!tab && Object.prototype.hasOwnProperty.call(NAME_MAX, tab.type); }
    /** A name as kept: one line, no control characters, single spaces, no longer than its kind allows. */
    function cleanName(text, max) {
        return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
    }

    /** Whether a thing open in a tab has changes not saved there (Rename from a list waits for them). */
    function unsavedIn(type, refId) {
        // (a tab opened for a new one holds it under its draft id: `savedId` once it is saved)
        return (state.tabs || []).some(t => t.type === type && (t.refId === refId || t.savedId === refId) && t.dirty);
    }
    /** A saved report, open in a tab or not (the Reporting list's Rename): the host checks and keeps the name. */
    function renameSavedReport(compareId, current) {
        if (!compareId || !window.DbmnModal || !window.vscode) return;
        askName(current, NAME_MAX.compare).then(name => {
            if (name && name !== current) window.vscode.postMessage({ type: 'renameReport', compareId, name });
        });
    }
    /** The one Rename dialog: resolves to the cleaned name, or '' when cancelled or unchanged. */
    function askRename(current, max) {
        if (!window.DbmnModal) return Promise.resolve('');
        return askName(current, max).then(name => (name && name !== current ? name : ''));
    }
    function askName(current, max) {
        return window.DbmnModal.show({
            title: 'Rename',
            fields: [{ id: 'name', type: 'text', label: 'Name', value: current, required: true, autoFocus: true, validate: { maxLength: max, message: `Up to ${max} characters` } }],
            actions: [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'rename', label: 'Rename', variant: 'primary' }]
        }).then(result => (result && result.actionId === 'rename' ? cleanName((result.fields || {}).name, max) : ''));
    }

    function buildTabElement(tab) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'hub-tab';
        el.draggable = true;
        el.dataset.tabId = tab.id;
        el.dataset.tabType = tab.type;
        el.setAttribute('role', 'tab');
        // Native tooltip — reveals the full tab name on hover when the
        // strip is packed and the visible name is ellipsed. Cheap and
        // matches VS Code's own tab-tooltip pattern.
        el.title = tab.name;
        if (tab.id === state.activeTabId) el.classList.add('is-active');
        if (tab.preview) el.classList.add('is-preview');
        if (tab.dirty) el.classList.add('is-dirty');
        if (STATUS_TYPES.has(tab.type) && tab.status) {
            el.classList.add(`is-${tab.status}`);
        }

        // Type glyph — reuses icons.js menu icons.
        const glyph = document.createElement('span');
        glyph.className = 'hub-tab-glyph icon';
        const glyphName = tab.type === 'page'
            ? (PAGE_GLYPH[tab.refId] || TYPE_GLYPH.page)
            // A query's tab is a compare tab by type (one kind of report tab); its icon is the Reporting list's:
            // a query's, or Compare's once a join is set to Compare
            : tab.type === 'compare' && String(tab.refId || '').indexOf('qry-') === 0 ? (compareQueries.has(tab.refId) ? 'scale' : 'blend') : TYPE_GLYPH[tab.type];
        glyph.setAttribute('data-icon', glyphName || 'notebook-tabs');
        el.appendChild(glyph);

        // Status icon — Console tabs only. Sits in the same slot the dot
        // used to occupy (after the type glyph, before the name). The
        // type glyph (play / folder-tree-play) is unchanged so the
        // run-type is still recognisable; the status icon adds the
        // state info (running / completed / failed / stopped / etc).
        if (STATUS_TYPES.has(tab.type) && tab.status) {
            const spec = window.Icons?.statusIcon?.(tab.status);
            if (spec && spec.icon) {
                const status = document.createElement('span');
                status.className = 'hub-tab-status icon';
                status.setAttribute('data-icon', spec.icon);
                status.setAttribute('data-bucket', spec.bucket);
                el.appendChild(status);
            }
        }

        // Name.
        const name = document.createElement('span');
        name.className = 'hub-tab-name';
        name.textContent = tab.name;
        el.appendChild(name);

        // Live progress label for active console tabs (running/paused/stopped).
        if (STATUS_TYPES.has(tab.type) && PROGRESS_STATUSES.has(tab.status) && tab.progress) {
            const label = document.createElement('span');
            label.className = `hub-tab-progress-label hub-tab-progress-label--${FOOTER_STATUS[tab.status] || tab.status}`;
            label.textContent = `${tab.progress.done}/${tab.progress.total}`;
            el.appendChild(label);
        }

        // Close button — its CSS swaps in a dirty dot when tab.is-dirty.
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'hub-tab-close';
        close.setAttribute('aria-label', tab.dirty ? 'Close (unsaved changes)' : 'Close');
        close.dataset.tabClose = tab.id;
        const closeIcon = document.createElement('span');
        closeIcon.className = 'icon';
        closeIcon.setAttribute('data-icon', 'x');
        close.appendChild(closeIcon);
        el.appendChild(close);

        // #438: a console tab shows its progress as the Console footer's status colour: a tint
        // behind the tab's own text and a solid line along the top, both as far as the run has
        // got (--tab-progress; hub.css). Kept after the run, so the final tally stays readable.
        const colour = tabColourOf(tab);
        if (colour) {
            el.classList.add('has-progress', `tab-tone--${colour}`);
            el.style.setProperty('--tab-progress', `${progressPercent(tab.progress)}%`);
            const bar = document.createElement('span');
            bar.className = `hub-tab-progress hub-tab-progress--${colour}`;
            bar.setAttribute('aria-hidden', 'true');
            el.appendChild(bar);
        }

        return el;
    }

    /* ─── Embedded iframe mount ──────────────────────────────────────── */
    //
    // Each tab body holds an <iframe> with srcdoc. The manager's HTML is
    // injected into the iframe's own document — isolated `window`, own
    // IIFE scope, own listeners. Closing a tab tears down the iframe and
    // all its state cleanly. Multiple tabs of the same type (e.g. two
    // open endpoints, three running consoles) coexist without collisions.
    //
    // CSS / JS load from `vscode-webview-resource:` URIs as in standalone
    // mode; the srcdoc shares the parent webview's origin for resource
    // fetching. A bootstrap script copies the parent's `--vscode-*` theme
    // tokens + body class into the iframe so VS Code theming resolves.
    // The vscode shim tags outgoing messages with the tab id and posts to
    // `window.parent` — handleWindowMessage forwards them to the host.

    /** Per-tabId iframe registry. Lookup for closing + payload dispatch. */
    const iframeRegistry = new Map();
    /** #438: the colour each Console's tab is drawn in, as last sent to it. */
    const sentTabColour = new Map();

    function ensureTabBodyEl(tabId) {
        const bodies = document.getElementById('hubTabBodies');
        if (!bodies) return null;
        let el = bodies.querySelector('[data-tab-body-id="' + cssEscape(tabId) + '"]');
        if (!el) {
            el = document.createElement('div');
            el.className = 'hub-tab-body';
            el.setAttribute('data-tab-body-id', tabId);
            bodies.appendChild(el);
        }
        return el;
    }

    function cssEscape(s) {
        return String(s).replace(/['"\\]/g, '\\$&');
    }

    /** The first script in every tab's frame (tab-frame.js): the `vscode` bridge, the inbound
     *  queue (G8), the ready signal (G5), dirty state and keys, and the Hub's theme. A file, not
     *  inline script, so the web app's Content Security Policy lets it run (#372); the tab's id
     *  rides on its tag. It sits beside this file, whichever host served them. */
    const TAB_FRAME_SRC = (function () {
        const base = (document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' ? location.href : '');
        try { return new URL('tab-frame.js', base).href; } catch (_e) { return 'tab-frame.js'; }   // a page with no base (unit tests)
    }());

    function escapeAttr(value) {
        return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** In VS Code, the script's text (hub-manager.ts): a tab's frame there can't fetch it. */
    function tabFrameSource() {
        const block = document.getElementById('dbmn-tab-frame-source');
        return block ? block.textContent : null;
    }

    function buildFrameScript(tabId) {
        const source = tabFrameSource();
        if (source) return '<script data-tab-id="' + escapeAttr(tabId) + '">' + source + '</script>';
        return '<script src="' + escapeAttr(TAB_FRAME_SRC) + '" data-tab-id="' + escapeAttr(tabId) + '"></script>';
    }

    /** Embed-mode CSS overrides for managers designed for standalone use.
     *  Injected at the END of <head> so it loads after the manager's own
     *  <link rel="stylesheet"> tags — that means simple element-level
     *  rules here win the cascade naturally without `!important`. */
    function buildEmbedOverridesStyle() {
        return (
            '<style id="__dbmnEmbedOverrides">\n' +
            '  /* Tab strip carries the close affordance, and the Hub header\n' +
            '   * button hides/shows the list column (Issue #292), so the\n' +
            '   * whole floating control cluster is redundant in embed mode. */\n' +
            '  .editor-window-controls { display: none; }\n' +
            '\n' +
            '  /* Drop the bottom paddings that core.css + Console template\n' +
            '   * use to reserve space for `position: fixed` footers in\n' +
            '   * standalone mode. In embed mode the body is sized to\n' +
            '   * (viewport - footer-h) so the footer sits in its own\n' +
            '   * region — the extra reservation just creates an empty\n' +
            '   * gap above the footer. Standalone webviews keep their\n' +
            '   * paddings because this stylesheet only applies inside\n' +
            '   * the iframe srcdoc. */\n' +
            '  body { padding-bottom: 0; }\n' +
            '  #report-container { padding-bottom: 0; }\n' +
            '\n' +
            '  /* Sticky webview-footer needs a containing scroll region\n' +
            '   * that stops above the footer, otherwise the scrollbar\n' +
            '   * runs the full viewport height — visually crossing the\n' +
            '   * footer. We size the body to viewport minus the footer\n' +
            '   * (measured at mount). `border-box` is critical: core.css\n' +
            '   * sets body padding to 20px/80px which under default\n' +
            '   * `content-box` would add ~100px to the rendered height,\n' +
            '   * pushing body past viewport and giving us the full-height\n' +
            '   * scrollbar that crosses the footer. */\n' +
            '  :root { --dbmn-footer-h: 0px; }\n' +
            '  html { height: 100vh; overflow: hidden; }\n' +
            '  body {\n' +
            '    box-sizing: border-box;\n' +
            '    height: calc(100vh - var(--dbmn-footer-h));\n' +
            '    overflow-y: auto;\n' +
            '    overflow-x: hidden;\n' +
            '  }\n' +
            '\n' +
            '  /* Themed slim scrollbars — match VS Code\'s scrollbar tokens\n' +
            '   * so they blend with the rest of the Hub instead of showing\n' +
            '   * the native chrome that the iframe defaults to. */\n' +
            '  ::-webkit-scrollbar { width: 10px; height: 10px; }\n' +
            '  ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(120,120,120,.3)); }\n' +
            '  ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(120,120,120,.45)); }\n' +
            '  ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground, rgba(120,120,120,.6)); }\n' +
            '  ::-webkit-scrollbar-track { background: transparent; }\n' +
            '  ::-webkit-scrollbar-corner { background: transparent; }\n' +
            '</style>'
        );
    }

    /** Construct the iframe srcdoc:
     *  - shim + theme bootstrap go at the TOP of <head> so they run
     *    BEFORE the manager's own scripts and tokens are available.
     *  - embed-mode CSS overrides go at the END of <head> so they load
     *    AFTER the manager's <link rel="stylesheet"> tags — natural
     *    cascade wins without `!important`. */
    function buildSrcdoc(tabId, html) {
        const headTop = buildFrameScript(tabId);
        const headEnd = buildEmbedOverridesStyle();

        let out = html;
        if (/<head[^>]*>/i.test(out)) {
            out = out.replace(/<head[^>]*>/i, function (m) { return m + headTop; });
        } else {
            out = headTop + out;
        }
        if (/<\/head>/i.test(out)) {
            out = out.replace(/<\/head>/i, function (m) { return headEnd + m; });
        } else {
            // No </head> — append before body content. Better than appending
            // at the end of the doc where it would shift rendering.
            out = out.replace(/<body[^>]*>/i, function (m) { return headEnd + m; });
        }
        return out;
    }

    function mountEmbeddedTab(spec) {
        const tabId = spec.tabId;
        // No-op stamp — kept so call sites still compile. Re-enable with
        // a real console.log when diagnosing mount/boot hangs.
        const stamp = (_label) => {};

        const body = ensureTabBodyEl(tabId);
        if (!body) { stamp('ABORT: no body element'); return; }
        body.setAttribute('data-mount-stage', 'pre');

        // Visible "Loading…" placeholder. Lives in the tab body BEFORE
        // the iframe is attached so the user always sees something while
        // the iframe's document parses. It's removed once the iframe
        // signals __embeddedReady__ (or stays visible if it never does,
        // making "blank console" obvious as a hang rather than empty).
        body.innerHTML = '';
        const loader = document.createElement('div');
        loader.className = 'hub-tab-loader';
        loader.setAttribute('data-tab-loader', tabId);
        loader.innerHTML =
            '<div class="hub-tab-loader-spinner"></div>' +
            '<div class="hub-tab-loader-text">Loading…</div>' +
            '<div class="hub-tab-loader-stage" data-loader-stage>preparing</div>';
        body.appendChild(loader);
        stamp('loader attached');

        const iframe = document.createElement('iframe');
        iframe.className = 'hub-tab-iframe';
        iframe.title = spec.name || tabId;
        iframe.setAttribute('data-tab-id', tabId);
        // Hide the iframe until __embeddedReady__ fires — keeps a
        // half-painted iframe from peeking through the loader.
        iframe.style.visibility = 'hidden';
        body.appendChild(iframe);
        stamp('iframe element attached (no srcdoc yet)');
        updateLoaderStage(tabId, 'attached');

        iframeRegistry.set(tabId, iframe);

        const tab = openOrFocusTab({
            id: tabId,
            type: spec.tabType || (tabId.split(':')[0] || 'endpoint'),
            refId: spec.refId,
            name: spec.name,
            preview: !!spec.preview
        });
        stamp('openOrFocusTab returned');

        if (tab && spec.status) {
            setStatus(tab.id, spec.status);
        }

        applyActiveBody();
        body.setAttribute('data-mount-stage', 'visible');
        stamp('body marked active');

        bootIframe(tabId, iframe, body, spec.html, stamp);
    }

    /* ─── Iframe boot ──────────────────────────────────────────────────
     *
     * Mount each tab's wrapped HTML into the iframe via a `blob:` URL.
     *
     * History note: an earlier implementation used `srcdoc` and defended
     * a Chromium quirk (deferred srcdoc parse on freshly-attached
     * iframes) with seven layered guards (G1–G7). Blob-URL navigation
     * goes through the normal document load path and doesn't hit that
     * quirk, so G1–G4 (rAF / setTimeout / layout-flush before srcdoc),
     * G6 (1.5s nudge) and G7 (3s blob-URL recovery) are all gone. See
     * docs/portability/spa-migration.md → "Three fix options" → Option 1.
     *
     * Two survivors, both in tab-frame.js:
     *   G5 — in-iframe ready signal. The iframe still posts
     *        `__embeddedReady__` when its document hits interactive /
     *        complete; the host removes the loader on that signal.
     *   G8 — inbound message buffer. Not iframe-specific — protects
     *        against the race between host broadcasts and the manager
     *        bundle's late-attached message listeners.
     */
    function bootIframe(tabId, iframe, _body, html, stamp) {
        const wrapped = buildSrcdoc(tabId, html);
        const blob = new Blob([wrapped], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        stamp('blob URL created (length=' + wrapped.length + ')');
        updateLoaderStage(tabId, 'mounting');
        iframe.addEventListener('load', () => {
            stamp('iframe load event');
            // Free the blob now that the iframe has parsed it.
            URL.revokeObjectURL(url);
            // A new page: it hasn't been told its tab's colour yet
            sentTabColour.delete(tabId);
            sendTabColours();
        }, { once: true });
        iframe.src = url;
        stamp('blob src assigned');
    }

    /** Update the loader stage line so the user (and we) can see how
     *  far mount got if it ever hangs. */
    function updateLoaderStage(tabId, text) {
        const bodies = document.getElementById('hubTabBodies');
        if (!bodies) return;
        const loader = bodies.querySelector('[data-tab-loader="' + cssEscape(tabId) + '"]');
        if (!loader) return;
        const stage = loader.querySelector('[data-loader-stage]');
        if (stage) stage.textContent = text;
    }

    /** Remove the loader for the given tab. Called when the iframe
     *  signals __embeddedReady__. */
    function removeLoader(tabId) {
        const bodies = document.getElementById('hubTabBodies');
        if (!bodies) return;
        const loader = bodies.querySelector('[data-tab-loader="' + cssEscape(tabId) + '"]');
        if (loader && loader.parentElement) loader.parentElement.removeChild(loader);
        const iframe = iframeRegistry.get(tabId);
        if (iframe) iframe.style.visibility = 'visible';
    }

    function unmountEmbeddedTab(tabId) {
        const iframe = iframeRegistry.get(tabId);
        if (iframe && iframe.parentElement) iframe.parentElement.remove();
        iframeRegistry.delete(tabId);
        sentTabColour.delete(tabId);
    }

    /* ─── Page tabs (GitHub Issue #292) ──────────────────────────────── */
    //
    // Settings / Account / Import / Export are page-style forms, not
    // list→detail sections, so they open in the content area as
    // single-instance tabs. The existing `.hub-section` DOM node is MOVED
    // into the tab body (a comment placeholder marks its home in
    // .hub-main) and moved back on close. Their JS (import-export-frontend,
    // account-frontend, wireSettings) resolves elements by id at call time
    // and listeners travel with the nodes, so nothing else changes, and
    // in-progress form state survives close/reopen.

    /** refId → placeholder comment node left in .hub-main. */
    const pageHomes = new Map();

    function pageTabId(refId) {
        return 'page:' + refId;
    }

    function mountPageTab(spec) {
        if (!spec || !spec.refId) return;
        const refId = spec.refId;
        const tabId = pageTabId(refId);
        const section = document.querySelector('.hub-section[data-section="' + cssEscape(refId) + '"]');
        const body = ensureTabBodyEl(tabId);
        if (section && body && !pageHomes.has(refId)) {
            const placeholder = document.createComment('page-home:' + refId);
            section.parentNode.insertBefore(placeholder, section);
            pageHomes.set(refId, placeholder);
            body.appendChild(section);
            section.hidden = false;
            section.classList.add('is-visible');
        }
        openOrFocusTab({ id: tabId, type: 'page', refId, name: spec.name || refId, preview: false });
        applyActiveBody();
    }

    function unmountPageTab(tabId) {
        const refId = tabId.slice('page:'.length);
        const placeholder = pageHomes.get(refId);
        const bodies = document.getElementById('hubTabBodies');
        const body = bodies && bodies.querySelector('[data-tab-body-id="' + cssEscape(tabId) + '"]');
        const section = body && body.querySelector('.hub-section[data-section="' + cssEscape(refId) + '"]');
        if (section && placeholder && placeholder.parentNode) {
            section.hidden = true;
            section.classList.remove('is-visible');
            placeholder.parentNode.insertBefore(section, placeholder);
            placeholder.remove();
        }
        pageHomes.delete(refId);
        if (body) body.remove();
    }

    function isPageTabId(id) {
        return typeof id === 'string' && id.indexOf('page:') === 0;
    }

    function applyActiveBody() {
        const bodies = document.getElementById('hubTabBodies');
        if (!bodies) return;
        const activeId = state.activeTabId;
        bodies.querySelectorAll('.hub-tab-body').forEach(function (el) {
            el.classList.toggle('is-active', el.getAttribute('data-tab-body-id') === activeId);
        });
    }

    /** Tell each Console its tab's colour when it changes: its heading wears it (console.css). */
    function sendTabColours() {
        for (const tab of state.tabs) {
            if (!STATUS_TYPES.has(tab.type)) continue;
            const colour = tabColourOf(tab);
            if (sentTabColour.get(tab.id) === colour || !iframeRegistry.has(tab.id)) continue;
            sentTabColour.set(tab.id, colour);
            dispatchToTab(tab.id, { type: 'hubTabColour', colour });
        }
    }

    /** Forward a host payload to the iframe hosting the given tab. The
     *  iframe's own `window.addEventListener('message', …)` listeners fire
     *  inside its document — no synthetic dispatch needed. */
    /** A message for every open tab of one type (endpoint, console, …). */
    function tellTabs(type, payload) {
        for (const tab of state.tabs) if (tab.type === type) dispatchToTab(tab.id, payload);
    }

    function dispatchToTab(tabId, payload) {
        const iframe = iframeRegistry.get(tabId);
        if (!iframe || !iframe.contentWindow) return;
        try { iframe.contentWindow.postMessage(payload, '*'); } catch (_e) { /* swallow */ }
    }

    /* ─── Window-message bridge: iframe → host ───────────────────────── */
    //
    // Each iframe's shim posts `{__embeddedFromTab__, tabId, payload}` to
    // window.parent. We catch those here and forward to the host via the
    // real vscode API. hub-manager.ts unwraps and routes to the bridge.

    function isEmbeddedFromTab(data) {
        return data && typeof data === 'object' && data.__embeddedFromTab__ === true && typeof data.tabId === 'string';
    }

    function handleWindowMessage(event) {
        const data = event.data;
        if (!isEmbeddedFromTab(data)) return;
        // Surface mount-stage signals as soon as the iframe shim posts
        // them — drops the loader + logs the timing so a hang is visible
        // both in the UI (loader stays) and in the console (timeline).
        if (data.payload && data.payload.type === '__embeddedReady__') {
            removeLoader(data.tabId);
        }
        // A screen that names its own tab (Run Batch: the batch it is about to run). Its name stands
        // from then on: the host's name for the tab (the endpoint's) no longer replaces it
        if (data.payload && data.payload.type === '__tabName__') {
            const named = (state.tabs || []).find(x => x.id === data.tabId);
            const name = named && canRename(named) ? cleanName(data.payload.name, NAME_MAX[named.type]) : '';
            if (name) {
                named.ownName = true;
                if (named.name !== name) { named.name = name; renderStrip(); }
            }
            return;
        }
        // #432: the endpoint editor's Manage tags… opens the Hub's Manage Tags dialog
        if (data.payload && data.payload.type === '__openTagManager__') {
            if (window.HubTagManager) window.HubTagManager.requestOpen();
            return;
        }
        // Ctrl/Cmd+W or Alt+W caught by the iframe shim when focus
        // was too deep for the outer VS Code keybinding to see it. Route through the
        // dirty-aware close and stop here — no host round-trip needed.
        if (data.payload && data.payload.type === '__requestCloseTab__') {
            if (window.DbmnModal?.isOpen?.()) {
                window.DbmnModal.requestDismiss();
                return;
            }
            requestClose(data.tabId);
            return;
        }
        try {
            if (window.vscode && typeof window.vscode.postMessage === 'function') {
                window.vscode.postMessage({
                    type: '__embeddedFromTab__',
                    tabId: data.tabId,
                    payload: data.payload
                });
            }
        } catch (_e) { /* swallow */ }
    }

    /* ─── Host-message hook: hub.js calls this from its handleMessage ── */

    function handleHostMessage(message) {
        if (!message) return false;
        switch (message.type) {
            case 'openPageTab':
                // Snapshot restore from the host (Issue #292) — the live
                // path goes through hub.js switchSection → openPageTab.
                mountPageTab({ refId: message.page, name: message.name });
                return true;
            case 'closeActiveTabFromHost':
                // Ctrl/Cmd+W or Alt+W routed via the contributed keybinding →
                // dbmn.hub.closeActiveTab → hub-manager.
                closeActiveTab();
                return true;
            case 'closeEmbeddedTabFromHost':
                // Manager's in-window close button posted `closeWebview`;
                // host echoed back so the frontend can drop the tab from
                // its strip in lockstep with the manager dispose.
                if (message.tabId) {
                    unmountEmbeddedTab(message.tabId);
                    closeTab(message.tabId);
                }
                return true;
            case 'embeddedTabDirty':
                // Iframe bootstrap detected the editor's heading switching
                // its `*` suffix on/off — propagate to the tab strip's
                // dirty state so the × becomes a ● and the close prompt
                // fires on close.
                if (message.tabId) markDirty(message.tabId, !!message.dirty);
                return true;
            case 'renamedOpen':
                // Renamed from the Hub's list while its editor is open (with nothing unsaved): the editor's name follows
                if (message.tabId && message.name) dispatchToTab(message.tabId, { type: 'dbmnRenamed', name: message.name });
                return true;
            case 'embeddedTabName': {
                // Host pushes the saved entity's current name (after
                // user saves an endpoint/env). Update the tab label
                // without remounting the iframe.
                if (message.tabId && message.name) {
                    const t = (state.tabs || []).find(x => x.id === message.tabId);
                    // A new one's tab, since saved: the endpoint or environment it now holds
                    if (t && message.savedId) t.savedId = message.savedId;
                    // (a tab its screen has named keeps that name)
                    if (t && !t.ownName && t.name !== message.name) {
                        t.name = message.name;
                        renderStrip();
                    }
                }
                return true;
            }
            case 'mountEmbeddedTab':
                mountEmbeddedTab({
                    tabId: message.tabId,
                    tabType: message.tabType,
                    refId: message.refId,
                    name: message.name,
                    preview: !!message.preview,
                    status: message.status,
                    html: message.html
                });
                return true;
            case 'focusEmbeddedTab': {
                const id = message.tabId;
                openOrFocusTab({
                    type: id ? id.split(':')[0] : 'endpoint',
                    refId: message.refId || (id ? id.split(':').slice(1).join(':') : ''),
                    name: message.name,
                    preview: !!message.preview
                });
                applyActiveBody();
                return true;
            }
            case '__embeddedToTab__':
                if (message.tabId && message.payload) {
                    dispatchToTab(message.tabId, message.payload);
                }
                return true;
            case 'setTabStatus':
                // Live per-tab progress + status push from the Hub host. Used
                // for Console tabs where the source of truth (progress on
                // batchStates) lives in-memory on the execution engine and
                // isn't reflected in the persisted transaction broadcast.
                if (message.tabId) {
                    const t = findTab(message.tabId);
                    if (t) setStatus(message.tabId, message.status || t.status, message.progress);
                    // Issue #312: the Activity drawer's progress bar reads the same signal.
                    // hub.js had a handler for it, but this returns true first, so the
                    // drawer never heard it and its bar sat empty for the whole run.
                    if (message.progress && window.HubActivity && window.HubActivity.applyLiveProgress) {
                        const refId = String(message.tabId).split(':').slice(1).join(':');
                        if (refId) window.HubActivity.applyLiveProgress(refId, message.progress);
                    }
                }
                return true;
            default:
                return false;
        }
    }

    /* ─── DOM wiring ──────────────────────────────────────────────────── */

    /** The close-tab key (Alt+W everywhere, Ctrl/Cmd+W in VS Code too). If a modal
     *  is open it owns the keystroke — mirror Escape (dismiss if dismissible, otherwise swallow).
     *  Never close the tab out from under an open modal. Otherwise the dirty-aware close. */
    function closeActiveTab() {
        if (window.DbmnModal?.isOpen?.()) {
            window.DbmnModal.requestDismiss();
            return;
        }
        if (state.activeTabId) requestClose(state.activeTabId);
    }

    /** Alt+W on the Hub page itself (a tab's own frame catches it in tab-frame.js), in the web
     *  and desktop apps, whose bootstrap leaves `__dbmnHostQueue`. VS Code's comes through its
     *  contributed keybinding (closeActiveTabFromHost) instead; both would close two tabs.
     *  `code` too: Option+W on a Mac reports ∑ as the key. */
    function watchAltW() {
        if (!window.__dbmnHostQueue) return;
        document.addEventListener('keydown', (e) => {
            if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (e.key !== 'w' && e.key !== 'W' && e.code !== 'KeyW') return;
            e.preventDefault();
            closeActiveTab();
        }, true);
    }

    function init() {
        watchAltW();
        const strip = document.getElementById('hubTabStrip');
        const wrapper = document.getElementById('hubTabStripWrapper');
        if (!strip || !wrapper) return;

        // Build the strip's siblings once: ‹ chevron before the strip,
        // › chevron + Close all after. They live in the wrapper so they
        // sit OUTSIDE the tab viewport — the tab strip visibly shrinks
        // to make room instead of the controls overlaying tabs.
        const chevLeft = buildScrollChevron('left');
        const chevRight = buildScrollChevron('right');
        const closeAll = buildCloseAllButton();
        closeAll.style.display = 'none';       // visibility toggled in renderStrip
        wrapper.insertBefore(chevLeft, strip);
        wrapper.appendChild(chevRight);
        wrapper.appendChild(closeAll);
        if (window.Icons) window.Icons.injectIcons(wrapper);

        // Wrapper-level delegation for the strip-adjacent action
        // buttons. Tab-internal clicks (close ×, activate) still go
        // through the strip's own listener below.
        wrapper.addEventListener('click', (e) => {
            const actionBtn = e.target.closest('[data-action]');
            if (!actionBtn || !wrapper.contains(actionBtn)) return;
            // Don't fire for clicks that are handled inside a tab (the
            // strip listener owns those).
            if (strip.contains(actionBtn)) return;
            e.stopPropagation();
            const action = actionBtn.getAttribute('data-action');
            if (action === 'scroll-left') {
                strip.scrollBy({ left: -Math.round(strip.clientWidth * 0.8), behavior: 'smooth' });
            } else if (action === 'scroll-right') {
                strip.scrollBy({ left: Math.round(strip.clientWidth * 0.8), behavior: 'smooth' });
            } else if (action === 'close-all') {
                closeAllTabs();
            }
        });

        // Click → focus (or close if click landed on the close button). The
        // close handler is wired via delegation here; the open path lives
        // wherever a section calls openOrFocusTab().
        strip.addEventListener('click', (e) => {
            const closeBtn = e.target.closest('[data-tab-close]');
            if (closeBtn) {
                e.stopPropagation();
                const id = closeBtn.getAttribute('data-tab-close');
                if (id) requestClose(id);
                return;
            }
            const tabEl = e.target.closest('.hub-tab');
            if (tabEl && tabEl.dataset.tabId) {
                const id = tabEl.dataset.tabId;
                focusTab(id);
            }
        });

        // Vertical mouse-wheel scrolls the strip horizontally, matching
        // VS Code's editor tab strip. Only when the gesture is purely
        // vertical — trackpad two-finger swipes with a horizontal
        // component keep their native behaviour.
        strip.addEventListener('wheel', (e) => {
            if (e.deltaY !== 0 && e.deltaX === 0) {
                strip.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });

        // Keep the ‹ / › chevrons in sync with the strip's scroll state
        // and its size (VS Code column resize + window resize both fire).
        strip.addEventListener('scroll', computeScrollAffordances, { passive: true });
        if (window.ResizeObserver) {
            new ResizeObserver(() => requestAnimationFrame(computeScrollAffordances)).observe(strip);
        }

        // Iframe → host forwarding lives at the Hub window level.
        window.addEventListener('message', handleWindowMessage);

        // Drag-to-reorder tabs. HTML5 native drag API; while dragging,
        // we add `.is-drop-target` to whichever tab the cursor hovers
        // and reorder on `drop`. Reorder fires HubTabs.reorderTab which
        // re-renders the strip.
        let draggingId = null;
        strip.addEventListener('dragstart', (e) => {
            const tabEl = e.target.closest('.hub-tab');
            if (!tabEl || !tabEl.dataset.tabId) return;
            draggingId = tabEl.dataset.tabId;
            tabEl.classList.add('is-dragging');
            try {
                e.dataTransfer.effectAllowed = 'move';
                // Some browsers refuse to fire dragover/drop without data.
                e.dataTransfer.setData('text/plain', draggingId);
            } catch (_e) { /* swallow */ }
        });
        strip.addEventListener('dragend', (e) => {
            const tabEl = e.target.closest('.hub-tab');
            if (tabEl) tabEl.classList.remove('is-dragging');
            strip.querySelectorAll('.hub-tab.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
            draggingId = null;
        });
        strip.addEventListener('dragover', (e) => {
            if (!draggingId) return;
            const tabEl = e.target.closest('.hub-tab');
            if (!tabEl || tabEl.dataset.tabId === draggingId) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_e) { /* swallow */ }
            strip.querySelectorAll('.hub-tab.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
            tabEl.classList.add('is-drop-target');
        });
        strip.addEventListener('drop', (e) => {
            if (!draggingId) return;
            const targetEl = e.target.closest('.hub-tab');
            if (!targetEl || !targetEl.dataset.tabId) return;
            e.preventDefault();
            const targetId = targetEl.dataset.tabId;
            const tabs = state.tabs;
            const fromIdx = tabs.findIndex(t => t.id === draggingId);
            const toIdx = tabs.findIndex(t => t.id === targetId);
            if (fromIdx === -1 || toIdx === -1) return;
            reorderTab(draggingId, toIdx);
        });

        subscribe(renderStrip);
        subscribe(applyActiveBody);

        // Post a serialisable snapshot of the tab strip to the host on
        // every state change (debounced to one animation frame to batch
        // rapid emits — drag, restore, bulk close). The host caches the
        // latest and writes it to workspaceState in its onDidDispose so
        // the working set survives a Hub close.
        let snapshotScheduled = false;
        subscribe(() => {
            if (snapshotScheduled) return;
            snapshotScheduled = true;
            requestAnimationFrame(() => {
                snapshotScheduled = false;
                try {
                    if (window.vscode?.postMessage) {
                        window.vscode.postMessage({
                            type: 'hubTabsSnapshot',
                            tabs: state.tabs.map(t => ({
                                type: t.type,
                                refId: t.refId,
                                name: t.name,
                                dirty: !!t.dirty
                            })),
                            activeTabId: state.activeTabId
                        });
                    }
                } catch (_e) { /* swallow */ }
            });
        });

        renderStrip();
    }

    /** Dirty-aware close. Routes through DbmnModal for a themed
     *  Save / Discard / Cancel dialog instead of the native confirm. */
    function requestClose(id) {
        const tab = findTab(id);
        if (!tab) return;
        if (!tab.dirty) {
            performClose(id);
            return;
        }
        if (!window.DbmnModal?.show) {
            // Fallback to native confirm if the modal helper isn't loaded.
            // eslint-disable-next-line no-alert
            if (window.confirm(`"${tab.name}" has unsaved changes. Discard them?`)) {
                performClose(id);
            }
            return;
        }
        // Run Batch has nothing to save: its unsaved work is data that has
        // not been run yet, so the choice is lose it or keep the tab.
        const isBatch = tab.type === 'batch';
        window.DbmnModal.show({
            title: 'Before we go on…',
            body: isBatch
                ? `"${tab.name}" has data that hasn't been run. Closing the tab loses it.`
                : `"${tab.name}" has unsaved changes.`,
            actions: isBatch
                ? [
                    { id: 'discard', label: 'Close and lose it', variant: 'destructive' },
                    { id: 'cancel',  label: 'Keep open', variant: 'primary' }
                ]
                : [
                    { id: 'save',    label: 'Save and Close', variant: 'primary' },
                    { id: 'discard', label: 'Discard',        variant: 'destructive' },
                    { id: 'cancel',  label: 'Cancel' }
                ],
            dismissible: true
        }).then((result) => {
            const choice = result?.actionId;
            if (choice === 'save') {
                // Trigger the manager's save via a tab payload — endpoint.js
                // listens for `saveCurrentEndpoint`, env.js for
                // `saveCurrentEnvironment`. Either way, the save handler
                // posts back state; we close after a short grace period.
                postSaveTrigger(tab);
                setTimeout(() => performClose(id), 400);
            } else if (choice === 'discard') {
                performClose(id);
            }
            // cancel / dismiss → no-op
        });
    }

    function postSaveTrigger(tab) {
        const iframe = iframeRegistry.get(tab.id);
        if (!iframe || !iframe.contentWindow) return;
        const message = tab.type === 'environment'
            ? { type: 'saveCurrentEnvironment' }
            : { type: 'saveCurrentEndpoint' };
        try { iframe.contentWindow.postMessage(message, '*'); } catch (_e) { /* swallow */ }
    }

    function performClose(id) {
        // Page tabs are hub-native: hand the section back to .hub-main and
        // skip the host round-trip (there is no embedded editor to dispose).
        if (isPageTabId(id)) {
            unmountPageTab(id);
            closeTab(id);
            return;
        }
        // Iframes own their lifecycle — removing the element disposes the
        // document + all its IIFE state cleanly. No listener leaks.
        unmountEmbeddedTab(id);
        closeTab(id);
        try {
            if (window.vscode && typeof window.vscode.postMessage === 'function') {
                window.vscode.postMessage({ type: 'closeEmbeddedTab', tabId: id });
            }
        } catch (_e) { /* swallow */ }
    }

    window.HubTabs = {
        init,
        renameSavedReport,
        askRename,
        unsavedIn,
        getState,
        subscribe,
        openOrFocusTab,
        focusTab,
        closeTab,
        markDirty,
        promotePreviewToKept,
        setStatus,
        reorderTab,
        handleHostMessage,
        tellTabs,
        mountEmbeddedTab,
        unmountEmbeddedTab,
        openPageTab: mountPageTab,
        setQueries,
        // Exposed for unit tests in pure JSDOM contexts.
        _makeTabId: makeTabId
    };
})();

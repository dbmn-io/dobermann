// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
(function () {
    'use strict';

    const rawVscode = acquireVsCodeApi();
    // Webview state does NOT survive a session: extension.ts disposes any
    // restored Hub and creates a fresh panel, so getState() starts empty
    // every launch. Every setState() here is therefore mirrored to the host
    // (`setHubPreferences` → globalState) and seeded back on first paint
    // (see seedStateFromHost). Debounced: sliders and drags call it often.
    let prefSyncTimer = null;
    function syncPreferencesToHost(state) {
        clearTimeout(prefSyncTimer);
        prefSyncTimer = setTimeout(() => {
            try { rawVscode.postMessage({ type: 'setHubPreferences', preferences: state || {} }); } catch { /* ignore */ }
        }, 150);
    }
    const vscode = {
        // Every outgoing message also passes the list drawer, which closes
        // when a list action opens or focuses a tab (Issue #349).
        postMessage: (msg) => { rawVscode.postMessage(msg); onListMessage(msg); },
        getState: () => rawVscode.getState(),
        setState: (next) => { rawVscode.setState(next); syncPreferencesToHost(next); }
    };
    // Shared with embedded modules (e.g. import-export-frontend.js) which
    // can't call acquireVsCodeApi() again.
    window.vscode = vscode;

    /** First paint of a fresh panel: adopt the host's copy of our preferences
     *  when the local store is empty. Local (in-session) state always wins. */
    function seedStateFromHost(prefs) {
        if (!prefs || typeof prefs !== 'object' || Object.keys(prefs).length === 0) return false;
        try {
            const local = rawVscode.getState();
            if (local && Object.keys(local).length > 0) return false;
            rawVscode.setState(Object.assign({}, prefs));
            return true;
        } catch { return false; }
    }
    let hubState = {
        endpoints: [],
        systems: [],
        environments: [],
        transactions: [],
        recentEndpoints: [],
        activeEnvironmentId: undefined,
        activeSystemId: undefined
    };
    /** The env most recently opened from this Hub — drives the row highlight in
     *  the Environments list. Distinct from `activeEnvironmentId`, which is the
     *  env that actually runs requests (marked with a satellite-dish icon). */
    let selectedEnvId = null;

    /** Resolver waiting for a `closeEditorsResult` from the host. Set when we
     *  send `requestCloseEditors`; cleared when the result arrives. */
    let closeEditorsResolver = null;

    /** Sections that are page-style forms rather than list→detail lists.
     *  They open as single-instance tabs in the content area instead of
     *  the list drawer (GitHub Issue #292). */
    const PAGE_SECTIONS = {
        import:   'Import',
        export:   'Export',
        account:  'Account',
        settings: 'Settings'
    };

    /* ─── List drawer — GitHub Issue #349 ──────────────────────────────
     *
     * The list panel (L2, `.hub-main`) is a drawer that slides over the tab
     * content from the rail's edge; the tab content never changes width.
     * `.hub-layout.drawer-open` shows it, `data-active-section` says which
     * list it holds.
     *
     *   - A list rail item opens the drawer on its list; clicking the same
     *     item again closes it.
     *   - Anything in a list that opens or focuses a tab closes it — caught
     *     in one place, on the way out to the host (onListMessage), using
     *     HubLayoutMath.drawerCloseDelay. A catalogue preview waits out the
     *     double-click window so the second click still lands on the row.
     *   - Escape, the scrim over the tab content, and the page sections
     *     (Import / Export / Account / Settings) close it too.
     *
     * `preferredDrawerW` is the width the user last dragged to (persisted as
     * `hubCol2Width`); the applied width is clamped from it on every layout
     * pass so a strip of tab content always shows beside the drawer. */
    let drawerOpen = false;
    let drawerCloseTimer = null;
    let preferredDrawerW = window.HubLayoutMath?.DEFAULT_DRAWER_W || 360;

    function layoutEl() {
        return document.querySelector('.hub-layout');
    }

    /** The list the drawer holds (shown or not). */
    function drawerSection() {
        return layoutEl()?.getAttribute('data-active-section') || 'catalogue';
    }

    /** Highlight one rail item, or none (`null`). */
    function renderRailActive(sectionId) {
        document.querySelectorAll('.hub-nav-item').forEach(btn => {
            const isActive = btn.dataset.section === sectionId;
            btn.classList.toggle('is-active', isActive);
            if (isActive) {
                btn.setAttribute('aria-current', 'page');
            } else {
                btn.removeAttribute('aria-current');
            }
        });
        syncRailMoreActive();
    }

    // ─── Rail overflow (Issue #293) ─────────────────────────────────────
    // Rail items never shrink. When the rail is too short for every top item,
    // items leave from the bottom of the top group up and sit behind `…`;
    // Account and Settings (the pinned bottom group) never move.

    /** `…` lights up when the highlighted item is one of those behind it. */
    function syncRailMoreActive() {
        const more = document.getElementById('hubNavMore');
        if (!more) return;
        const hiddenActive = !!document.querySelector('.hub-nav-top .hub-nav-item.is-overflowed.is-active');
        more.classList.toggle('is-active', hiddenActive);
    }

    function layoutRailOverflow() {
        const top = document.querySelector('.hub-nav-top');
        const more = document.getElementById('hubNavMore');
        if (!top || !more) return;
        // Items switched off (.hidden: Compare while its feature flag is off) take no room
        const items = Array.from(top.querySelectorAll('.hub-nav-item:not(.hub-nav-more):not(.hidden)'));
        top.querySelectorAll('.hub-nav-item.hidden').forEach(btn => btn.classList.remove('is-overflowed'));
        items.forEach(btn => btn.classList.remove('is-overflowed'));
        more.classList.add('is-overflowed');
        const fits = () => top.scrollHeight <= top.clientHeight;
        if (!fits()) {
            more.classList.remove('is-overflowed');
            for (let i = items.length - 1; i >= 0 && !fits(); i--) {
                items[i].classList.add('is-overflowed');
            }
        }
        if (more.classList.contains('is-overflowed')) closeRailMore();
        syncRailMoreActive();
    }

    function closeRailMore() {
        document.getElementById('hubNavMorePopup')?.classList.add('hidden');
        document.getElementById('hubNavMore')?.setAttribute('aria-expanded', 'false');
    }

    function openRailMore() {
        const more = document.getElementById('hubNavMore');
        const popup = document.getElementById('hubNavMorePopup');
        if (!more || !popup) return;
        popup.innerHTML = '';
        document.querySelectorAll('.hub-nav-top .hub-nav-item.is-overflowed:not(.hub-nav-more):not(.hidden)').forEach(btn => {
            const item = document.createElement('div');
            item.className = 'hub-env-popup-item' + (btn.classList.contains('is-active') ? ' is-active' : '');
            item.setAttribute('role', 'menuitem');
            item.dataset.section = btn.dataset.section;
            item.innerHTML = '<span class="icon"></span><span class="hub-env-popup-name"></span>';
            item.querySelector('.icon').dataset.icon = btn.querySelector('.hub-nav-icon')?.dataset.icon || '';
            item.querySelector('.hub-env-popup-name').textContent = btn.querySelector('.hub-nav-label')?.textContent?.trim() || '';
            item.addEventListener('click', () => {
                closeRailMore();
                btn.click();
            });
            popup.appendChild(item);
        });
        if (window.Icons) window.Icons.injectIcons(popup);
        const r = more.getBoundingClientRect();
        popup.style.left = (r.right + 4) + 'px';
        popup.style.top = r.top + 'px';
        popup.classList.remove('hidden');
        more.setAttribute('aria-expanded', 'true');
    }

    function wireRailMore() {
        const more = document.getElementById('hubNavMore');
        if (!more) return;
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            const popup = document.getElementById('hubNavMorePopup');
            if (popup && !popup.classList.contains('hidden')) closeRailMore();
            else openRailMore();
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest?.('#hubNavMorePopup')) closeRailMore();
        });
        document.addEventListener('keydown', (e) => {
            const popup = document.getElementById('hubNavMorePopup');
            if (e.key === 'Escape' && popup && !popup.classList.contains('hidden')) {
                e.preventDefault();
                closeRailMore();
                more.focus();
            }
        });
    }

    /** Rail highlight: the drawer's list while it is open; otherwise the rail
     *  item that owns the active tab; nothing at all on Home (no tabs). */
    function syncRail() {
        if (drawerOpen) {
            renderRailActive(drawerSection());
            return;
        }
        const tabs = window.HubTabs?.getState?.();
        const active = tabs?.tabs?.find(t => t.id === tabs.activeTabId);
        renderRailActive(window.HubLayoutMath?.sectionForTab(active) || null);
    }

    /** Put `sectionId`'s list in the drawer (does not open it). */
    function applySectionSwitch(sectionId) {
        document.querySelectorAll('.hub-section').forEach(section => {
            // A page section living inside a tab body is owned by the tab
            // system — leave it alone.
            if (section.closest('.hub-tab-body')) return;
            const isVisible = section.dataset.section === sectionId;
            section.classList.toggle('is-visible', isVisible);
            section.hidden = !isVisible;
        });
        layoutEl()?.setAttribute('data-active-section', sectionId);
        syncRail();
    }

    function setDrawerOpen(open) {
        clearTimeout(drawerCloseTimer);
        drawerCloseTimer = null;
        if (drawerOpen === open) return;
        drawerOpen = open;
        layoutEl()?.classList.toggle('drawer-open', open);
        document.querySelector('.hub-main')?.setAttribute('aria-hidden', open ? 'false' : 'true');
        syncRail();
    }

    /** Move focus into the drawer: the list's search box, or the first
     *  environment row (Environments has no search). */
    function focusDrawer(sectionId) {
        const target = sectionId === 'catalogue' ? document.getElementById('catalogueSearch')
            : sectionId === 'transactions' ? document.getElementById('transactionsSearch')
            : sectionId === 'compare' ? document.getElementById('compareSearch')
            : document.querySelector('#hubEnvironmentList [data-env-id], #hubEnvironmentList button');
        if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    }

    function openDrawer(sectionId) {
        applySectionSwitch(sectionId);
        setDrawerOpen(true);
        focusDrawer(sectionId);
    }

    function closeDrawer(opts) {
        if (!drawerOpen) return;
        setDrawerOpen(false);
        if (opts && opts.restoreFocus) {
            document.querySelector('.hub-nav-item[data-section="' + drawerSection() + '"]')?.focus();
        }
    }

    /** Every message the Hub posts passes through here (see `vscode` above). */
    function onListMessage(msg) {
        if (!drawerOpen) return;
        const delay = window.HubLayoutMath?.drawerCloseDelay(msg);
        if (delay == null) return;
        clearTimeout(drawerCloseTimer);
        if (delay === 0) {
            closeDrawer();
            return;
        }
        drawerCloseTimer = setTimeout(() => {
            drawerCloseTimer = null;
            closeDrawer();
        }, delay);
    }

    function switchSection(sectionId) {
        // Logs is a screen of its own, one tab (Dobermann issue 7)
        if (sectionId === 'logs') {
            closeDrawer();
            vscode.postMessage({ type: 'openLogs' });
            return;
        }
        // Page-style sections open as tabs (Issue #292) and close the drawer.
        if (PAGE_SECTIONS[sectionId]) {
            closeDrawer();
            window.HubTabs?.openPageTab?.({ refId: sectionId, name: PAGE_SECTIONS[sectionId] });
            // The Account page defers its network stats fetch (and any "showing
            // cached data" warning) until it's actually viewed.
            if (sectionId === 'account') {
                vscode.postMessage({ type: 'accountSectionShown' });
            }
            return;
        }
        openDrawer(sectionId);
    }

    /**
     * Editor was disposed externally (× button, tab close, etc). Clear the
     * matching selection state and, while the drawer is closed, put the
     * matching list in it so the next open lands somewhere coherent:
     *   - endpoint    → Catalogue (clears Catalogue's selectedEndpointId)
     *   - environment → Environments (clears selectedEnvId)
     *   - transaction → History (clears Transactions' selectedTxId)
     */
    function handleEditorClosed(context) {
        let targetSection = null;
        if (context === 'endpoint' || context === 'runBatch') {
            // Both originate from the Catalogue (row click vs Run icon /
            // smart-run-with-template-vars), so they land back there on close.
            if (window.Catalogue?.clearSelection) window.Catalogue.clearSelection();
            targetSection = 'catalogue';
        } else if (context === 'environment') {
            selectedEnvId = null;
            renderEnvironmentsSection();
            targetSection = 'environments';
        } else if (context === 'transaction') {
            if (window.Transactions?.clearSelection) window.Transactions.clearSelection();
            targetSection = 'transactions';
        }
        if (targetSection && !drawerOpen) {
            applySectionSwitch(targetSection);
        }
    }

    function requestCloseOpenEditors() {
        return new Promise(resolve => {
            closeEditorsResolver = resolve;
            vscode.postMessage({ type: 'requestCloseEditors' });
            // Safety: if the host never responds, don't deadlock the UI.
            setTimeout(() => {
                if (closeEditorsResolver === resolve) {
                    closeEditorsResolver = null;
                    resolve(true);
                }
            }, 5000);
        });
    }

    /** Width the drawer may use: the tab content area it covers. */
    function drawerAvailableWidth() {
        return document.getElementById('hubContent')?.clientWidth || layoutEl()?.clientWidth || 0;
    }

    function applyLayout() {
        const layout = layoutEl();
        const math = window.HubLayoutMath;
        if (!layout || !math) return;

        const clamped = math.clampDrawerWidth(preferredDrawerW, drawerAvailableWidth());
        if (layout.style.getPropertyValue('--hub-col2-w').trim() !== clamped + 'px') {
            layout.style.setProperty('--hub-col2-w', clamped + 'px');
        }

        // The rail is always icons only (Issue #348): its names are tooltips.
        syncNavItemTitles(true);
        layoutRailOverflow();
    }

    // Exposed for tests and for other Hub modules.
    window.HubLayout = { openDrawer, closeDrawer, isDrawerOpen: () => drawerOpen, switchSection, applyLayout };

    /** Apply / clear the tooltip on each nav item to match the rail form.
     *  With tabs open the rail is icon-only — the title attribute surfaces
     *  the label as a hover tooltip. With no tabs the label is visible
     *  inline so the tooltip would be redundant noise.
     *
     *  The first call captures each item's "icon-only title" into a data
     *  attribute: items that already had a descriptive `title=` in the
     *  HTML (Import / Export / Account) keep that text; the rest use their
     *  label. Captured once so toggling repeatedly doesn't lose the
     *  original descriptive variants. */
    function syncNavItemTitles(iconOnly) {
        document.querySelectorAll('.hub-nav-item').forEach(btn => {
            if (!btn.dataset.collapsedTitle) {
                const existing = btn.getAttribute('title');
                const label = btn.querySelector('.hub-nav-label')?.textContent?.trim() || '';
                btn.dataset.collapsedTitle = existing || label;
            }
            if (iconOnly) {
                btn.title = btn.dataset.collapsedTitle;
            } else {
                btn.removeAttribute('title');
            }
        });
    }

    /** Re-run the layout pass whenever the Hub, or the tab content area the
     *  drawer covers, is resized so the drawer width is re-clamped. */
    function wireHubResize() {
        const layout = layoutEl();
        if (!layout) return;
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; applyLayout(); });
        };
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(schedule);
            ro.observe(layout);
            const content = document.getElementById('hubContent');
            if (content) ro.observe(content);
        }
        window.addEventListener('resize', schedule);
    }

    function wireNav() {
        document.querySelectorAll('.hub-nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                const section = btn.dataset.section;
                if (!section) return;
                // A list rail item toggles the drawer on its list.
                if (!PAGE_SECTIONS[section] && drawerOpen && drawerSection() === section) {
                    closeDrawer();
                    return;
                }
                switchSection(section);
            });
        });

        document.getElementById('hubDrawerScrim')?.addEventListener('click', () => closeDrawer());

        // Escape closes the drawer. On `window` so it runs after the modal and
        // context-menu handlers on `document`, which claim their own Escape
        // with preventDefault.
        window.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !drawerOpen || e.defaultPrevented) return;
            if (window.DbmnModal?.isOpen?.()) return;
            e.preventDefault();
            closeDrawer({ restoreFocus: true });
        });

        document.querySelector('.hub-main')?.setAttribute('aria-hidden', 'true');

        wireColResize();
        wireHubResize();
    }

    /** Drag handle on the drawer's right edge. Updates the `--hub-col2-w`
     *  custom property on `.hub-layout` and persists the chosen width
     *  across sessions. */
    function wireColResize() {
        const handle = document.getElementById('hubColResize');
        const layout = layoutEl();
        if (!handle || !layout) return;

        const math = window.HubLayoutMath;
        const clamp = (px) => math ? math.clampDrawerWidth(px, drawerAvailableWidth()) : px;

        const beginDrag = (startX, startWidth) => {
            layout.classList.add('is-resizing');
            const onMove = (clientX) => {
                const delta = clientX - startX;
                const next = clamp(startWidth + delta);
                layout.style.setProperty('--hub-col2-w', next + 'px');
            };
            const onUp = () => {
                layout.classList.remove('is-resizing');
                window.removeEventListener('mousemove', mouseMove);
                window.removeEventListener('mouseup', mouseUp);
                const finalW = parseInt(layout.style.getPropertyValue('--hub-col2-w'), 10);
                if (finalW) {
                    preferredDrawerW = finalW;
                    persistState({ hubCol2Width: finalW + 'px' });
                }
            };
            const mouseMove = (e) => onMove(e.clientX);
            const mouseUp = () => onUp();
            window.addEventListener('mousemove', mouseMove);
            window.addEventListener('mouseup', mouseUp);
        };

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const cur = layout.style.getPropertyValue('--hub-col2-w').trim();
            const startWidth = parseInt(cur, 10) || preferredDrawerW;
            beginDrag(e.clientX, startWidth);
        });

        // Keyboard accessibility: arrow keys nudge by 24px.
        handle.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const cur = parseInt(layout.style.getPropertyValue('--hub-col2-w'), 10) || preferredDrawerW;
            const clamped = clamp(cur + (e.key === 'ArrowRight' ? 24 : -24));
            layout.style.setProperty('--hub-col2-w', clamped + 'px');
            preferredDrawerW = clamped;
            persistState({ hubCol2Width: clamped + 'px' });
        });
    }

    // ─── Env selector in the nav header ────────────────────────────────
    function wireEnvSelector() {
        const btn = document.getElementById('hubEnvSelector');
        const popup = document.getElementById('hubEnvPopup');
        // The same sign-in as Account's "Sign in to DBMN" (it registers new emails too)
        const signIn = document.getElementById('hubSignInBtn');
        if (signIn) signIn.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
        // Issue #396: an expired DBMN sign-in. Same sign-in; the selector stays, runs carry on.
        const expired = document.getElementById('hubSessionExpiredBtn');
        if (expired) expired.addEventListener('click', () => vscode.postMessage({ type: 'signIn' }));
        if (!btn || !popup) return;

        function open() {
            renderEnvPopupList();
            popup.classList.remove('hidden');
            btn.setAttribute('aria-expanded', 'true');
            setTimeout(() => document.addEventListener('mousedown', outsideClickHandler), 0);
        }
        function close() {
            popup.classList.add('hidden');
            btn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', outsideClickHandler);
        }
        function outsideClickHandler(e) {
            if (!btn.contains(e.target) && !popup.contains(e.target)) close();
        }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (popup.classList.contains('hidden')) open();
            else close();
        });

        popup.addEventListener('click', (e) => {
            // A row's pencil (that environment's editor), or New environment at the foot
            const action = e.target.closest('[data-env-action]');
            if (action) {
                close();
                if (action.dataset.envAction === 'edit') vscode.postMessage({ type: 'openEnvironmentAsTab', environmentId: action.dataset.envId });
                else vscode.postMessage({ type: 'addEnvironment' });
                return;
            }
            const envRow = e.target.closest('[data-env-id]');
            if (!envRow) return;
            close();
            vscode.postMessage({ type: 'setActiveEnvironment', environmentId: envRow.dataset.envId });
        });

        wireEnvVarSegments(close);
    }

    /**
     * #424: the segments after the environment's name, one per variable its header shows. Each
     * opens its own list under itself; a pick sets that variable and nothing else. Left and
     * right arrows move between the segments; Escape closes.
     */
    function wireEnvVarSegments(closeEnvPopup) {
        const wrap = document.getElementById('hubEnvVars');
        if (!wrap) return;
        let openSegment = null;
        function close() {
            if (!openSegment) return;
            openSegment.querySelector('.hub-env-popup')?.classList.add('hidden');
            openSegment.querySelector('.hub-env-seg')?.setAttribute('aria-expanded', 'false');
            openSegment = null;
            document.removeEventListener('mousedown', outside);
        }
        function open(segment) {
            close();
            closeEnvPopup();
            openSegment = segment;
            segment.querySelector('.hub-env-popup')?.classList.remove('hidden');
            segment.querySelector('.hub-env-seg')?.setAttribute('aria-expanded', 'true');
            setTimeout(() => document.addEventListener('mousedown', outside), 0);
        }
        function outside(e) {
            if (openSegment && !openSegment.contains(e.target)) close();
        }
        wrap.addEventListener('click', (e) => {
            const button = e.target.closest('.hub-env-seg');
            if (button) {
                const segment = button.closest('.hub-env-var');
                if (openSegment === segment) close(); else open(segment);
                return;
            }
            const add = e.target.closest('[data-add-var]');
            if (add) {
                close();
                vscode.postMessage({ type: 'addVariableOption', environmentId: add.dataset.envId, name: add.dataset.addVar });
                return;
            }
            const option = e.target.closest('[data-env-id][data-var][data-value]');
            if (!option) return;
            close();
            vscode.postMessage({ type: 'setEnvironmentVariable', environmentId: option.dataset.envId, name: option.dataset.var, value: option.dataset.value });
        });
        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); return; }
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            const buttons = [document.getElementById('hubEnvSelector'), ...wrap.querySelectorAll('.hub-env-seg')];
            const at = buttons.indexOf(document.activeElement);
            if (at < 0) return;
            const next = buttons[at + (e.key === 'ArrowRight' ? 1 : -1)];
            if (next) { e.preventDefault(); next.focus(); }
        });
        document.getElementById('hubEnvSelector')?.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight') return;
            const first = wrap.querySelector('.hub-env-seg');
            if (first) { e.preventDefault(); first.focus(); }
        });
        wrap.closeAll = close;
    }

    /**
     * #344: 'connected' | 'away' | 'unchecked' from a host that reaches DBMN for VS Code (the web
     * app); undefined in VS Code itself, where an environment that "runs in VS Code" just runs.
     */
    let agentConnection;
    const AGENT_LINK_TITLES = {
        connected: 'Runs in DBMN for VS Code: connected',
        away: 'Runs in DBMN for VS Code: not open. Runs wait until it is.',
        unchecked: 'Runs in DBMN for VS Code: checked when you run'
    };

    /**
     * The icon beside an environment that runs in DBMN for VS Code, and the page's
     * data-agent-connection (tab frames mirror it, so the Console title's icon agrees).
     */
    function renderAgentLink(active) {
        const link = document.getElementById('hubEnvAgent');
        const state = active && active.runOn === 'local-agent' ? agentConnection : undefined;
        if (agentConnection) document.documentElement.setAttribute('data-agent-connection', agentConnection);
        else document.documentElement.removeAttribute('data-agent-connection');
        if (!link) return;
        link.classList.toggle('hidden', !state);
        if (!state) return;
        link.title = AGENT_LINK_TITLES[state];
        link.setAttribute('aria-label', AGENT_LINK_TITLES[state]);
    }

    function renderEnvSelector() {
        const label = document.getElementById('hubEnvCurrent');
        if (!label) return;
        // Signed out of DBMN: Sign in is offered beside the selector (#418: everything runs
        // signed out; the account adds storage, Standard Systems and Weekly Usage).
        // Only an explicit false: before the first state arrives, no Sign in button.
        const signedOut = hubState.isSignedIn === false;
        const selector = document.getElementById('hubEnvSelector');
        const signIn = document.getElementById('hubSignInBtn');
        if (signIn) signIn.classList.toggle('hidden', !signedOut);
        const expired = document.getElementById('hubSessionExpiredBtn');
        if (expired) expired.classList.toggle('hidden', signedOut || hubState.dbmnSessionExpired !== true);
        if (signedOut) {
            const popup = document.getElementById('hubEnvPopup');
            if (popup) popup.classList.add('hidden');
            if (selector) selector.setAttribute('aria-expanded', 'false');
        }
        const active = (hubState.environments || []).find(e => e.id === hubState.activeEnvironmentId);
        renderAgentLink(active);
        // GitHub Issue #273: flag the header red when connected to production so
        // it's unmistakable which environment we're about to hit.
        const header = document.querySelector('.hub-header');
        if (header) {
            header.classList.toggle('is-production', active?.environmentType === 'production');
        }
        if (!active) {
            label.textContent = 'No environment';
            label.classList.add('is-empty');
            // The last environment's variables go with it (signed out, its catalogue is hidden)
            renderEnvVarSegments(null);
            return;
        }
        label.classList.remove('is-empty');
        label.textContent = active.name;
        renderEnvVarSegments(active);
    }

    /**
     * #424: after the name, one segment per variable the active environment shows in its header,
     * reading its value (or `pick <name>` until it has one of its options). Each has its own list
     * under it, ending in "Add". With none, the header is the name alone.
     */
    function renderEnvVarSegments(active) {
        const wrap = document.getElementById('hubEnvVars');
        if (!wrap) return;
        wrap.closeAll?.();
        wrap.innerHTML = '';
        const variables = active && Array.isArray(active.headerVariables) ? active.headerVariables : [];
        // With variables, the environment and its variables are drawn as one group (hub.css)
        wrap.closest('.hub-env-selector-wrap')?.classList.toggle('has-vars', variables.length > 0 && hubState.isSignedIn !== false);
        variables.forEach(variable => {
            const segment = document.createElement('div');
            // With options, the value counts only when it is one of them; with none, whatever it holds.
            // An option with a label shows the label; requests send the value (#424)
            const current = variable.options.length === 0 || variable.options.includes(variable.value) ? variable.value : '';
            const labels = variable.labels || {};
            segment.className = 'hub-env-var';
            segment.dataset.var = variable.name;
            segment.innerHTML =
                '<button type="button" class="hub-env-seg" aria-haspopup="listbox" aria-expanded="false">' +
                    '<span class="hub-env-seg-value"></span><span class="hub-env-caret icon" data-icon="chevron-down"></span>' +
                '</button>' +
                '<div class="hub-env-popup hub-env-var-popup hidden" role="listbox"><div class="hub-env-popup-var"></div></div>';
            const button = segment.querySelector('.hub-env-seg');
            const valueEl = segment.querySelector('.hub-env-seg-value');
            button.title = current ? `${variable.name}: ${labels[current] ? `${labels[current]} (${current})` : current}` : `Pick ${variable.name}`;
            valueEl.textContent = (current && labels[current]) || current || `pick ${variable.name}`;
            button.classList.toggle('is-missing', !current);
            segment.querySelector('.hub-env-popup-var').textContent = variable.name;
            const popup = segment.querySelector('.hub-env-popup');
            variable.options.forEach(option => {
                const row = document.createElement('div');
                const isCurrent = option === variable.value;
                row.className = 'hub-env-popup-org' + (isCurrent ? ' is-current' : '');
                row.dataset.envId = active.id;
                row.dataset.var = variable.name;
                row.dataset.value = option;
                row.setAttribute('role', 'option');
                row.innerHTML = '<span class="hub-env-popup-org-name"></span><span class="hub-env-popup-org-value"></span>' +
                    (isCurrent ? '<span class="hub-env-popup-org-check icon" data-icon="check"></span>' : '');
                row.querySelector('.hub-env-popup-org-name').textContent = labels[option] || option;
                row.querySelector('.hub-env-popup-org-value').textContent = labels[option] ? option : '';
                popup.appendChild(row);
            });
            const add = document.createElement('div');
            add.className = 'hub-env-popup-action';
            add.dataset.envId = active.id;
            add.dataset.addVar = variable.name;
            add.setAttribute('role', 'option');
            add.innerHTML = '<span class="icon" data-icon="plus"></span><span>Add…</span>';
            popup.appendChild(add);
            wrap.appendChild(segment);
        });
        if (window.Icons) window.Icons.injectIcons(wrap);
    }

    function renderEnvPopupList() {
        const popup = document.getElementById('hubEnvPopup');
        if (!popup) return;
        popup.innerHTML = '';
        const envs = (hubState.environments || []).slice().sort((a, b) =>
            (a.name || '').localeCompare(b.name || '')
        );
        if (envs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'hub-env-popup-empty';
            empty.textContent = 'No environments yet.';
            popup.appendChild(empty);
            appendEnvPopupActions(popup);
            if (window.Icons) window.Icons.injectIcons(popup);
            return;
        }
        envs.forEach(env => {
            const item = document.createElement('div');
            // Production entries render in the warning colour, matching the header you get once
            // one is active — so the risky choice is obvious at the point of
            // picking it, not just after.
            item.className = 'hub-env-popup-item'
                + (env.id === hubState.activeEnvironmentId ? ' is-active' : '')
                + (env.environmentType === 'production' ? ' is-production' : '');
            item.dataset.envId = env.id;
            item.setAttribute('role', 'option');
            const sub = env.baseUrl ? '<span class="hub-env-popup-sub"></span>' : '';
            // #344: where VS Code is reached from, an environment that runs there says so
            const agent = agentConnection && env.runOn === 'local-agent'
                ? '<span class="hub-env-popup-agent icon" data-icon="vscode" title="Runs in DBMN for VS Code" aria-label="Runs in DBMN for VS Code"></span>' : '';
            // Each row has its own pencil: opens that environment's editor, without switching to it
            item.innerHTML = '<span class="hub-env-popup-text"><span class="hub-env-popup-head"><span class="hub-env-popup-name"></span>' + agent + '</span>' + sub + '</span>' +
                '<button type="button" class="hub-env-popup-edit icon" data-icon="pencil" data-env-action="edit"></button>';
            item.querySelector('.hub-env-popup-name').textContent = env.name || '(unnamed)';
            const subEl = item.querySelector('.hub-env-popup-sub');
            if (subEl) subEl.textContent = env.baseUrl || '';
            const editBtn = item.querySelector('.hub-env-popup-edit');
            editBtn.dataset.envId = env.id;
            editBtn.title = `Edit ${env.name || 'environment'}`;
            editBtn.setAttribute('aria-label', editBtn.title);
            popup.appendChild(item);
        });
        appendEnvPopupActions(popup);
        // Hydrate the icons in the freshly-built popup.
        if (window.Icons) window.Icons.injectIcons(popup);
    }

    /** At the foot of the environment list: a new one. (Each row has its own Edit pencil.) */
    function appendEnvPopupActions(popup) {
        const foot = document.createElement('div');
        foot.className = 'hub-env-popup-actions';
        const add = document.createElement('div');
        add.className = 'hub-env-popup-action';
        add.dataset.envAction = 'new';
        add.setAttribute('role', 'option');
        add.innerHTML = '<span class="icon" data-icon="plus"></span><span>New environment…</span>';
        foot.appendChild(add);
        popup.appendChild(foot);
    }

    // ─── Settings section: catalogue Group by + Recent + Systems list ────
    // (#444: Show: Current System went; `@` in the search box is the current System)
    function wireSettings() {
        const groupCtrl = document.getElementById('catalogueGroupBy');

        groupCtrl?.addEventListener('change', () => {
            const value = groupCtrl.value;
            persistState({ catalogueGroupBy: value });
            notifyCatalogueSettings();
        });
        const recentCtrl = document.getElementById('catalogueShowRecent');
        recentCtrl?.addEventListener('change', () => {
            persistState({ catalogueShowRecent: recentCtrl.checked });
            notifyCatalogueSettings();
        });

        // Transactions settings
        const txShow = document.getElementById('transactionsShow');
        const txGroup = document.getElementById('transactionsGroupBy');
        txShow?.addEventListener('change', () => {
            persistState({ transactionsShow: txShow.value });
            notifyTransactionsSettings();
        });
        txGroup?.addEventListener('change', () => {
            persistState({ transactionsGroupBy: txGroup.value });
            notifyTransactionsSettings();
        });

        document.getElementById('hubAddSystem')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'createSystem' });
        });

        // ── Execution + UI settings ──────────────────────────────────────
        const bindToggle = (id, key) => {
            const el = document.getElementById(id);
            el?.addEventListener('change', () => {
                vscode.postMessage({ type: 'setDbmnSetting', key, value: !!el.checked });
            });
        };
        bindToggle('autoOpenConsole', 'execution.autoOpenConsoleOnCompletion');
        bindToggle('treatNetworkErrorsAsCritical', 'execution.treatNetworkErrorsAsCritical');
        bindToggle('confirmTransactionDeletion', 'ui.confirmTransactionDeletion');
        bindToggle('telemetryEnabled', 'telemetry.enabled');   // #419
        // #373: the theme is the host's to offer (themeOptions) and to keep; VS Code never offers one
        document.getElementById('uiTheme')?.addEventListener('change', event => {
            vscode.postMessage({ type: 'setTheme', id: event.target.value });
        });
        for (const mode of ['light', 'dark']) {
            document.getElementById(mode === 'light' ? 'uiThemeLight' : 'uiThemeDark')?.addEventListener('change', event => {
                vscode.postMessage({ type: 'setSystemTheme', mode, id: event.target.value });
            });
        }

        // maxCsvRows — debounce so we don't write on every keystroke.
        let maxCsvRowsTimer = null;
        const maxCsvRowsEl = document.getElementById('maxCsvRows');
        maxCsvRowsEl?.addEventListener('input', () => {
            clearTimeout(maxCsvRowsTimer);
            // Saving soon: a refresh meanwhile (a setting changed here or elsewhere) must not put
            // the old value back, or the save sends that instead (seen 2026-10-10)
            maxCsvRowsEl.dataset.pending = 'true';
            maxCsvRowsTimer = setTimeout(() => {
                delete maxCsvRowsEl.dataset.pending;
                const n = parseInt(maxCsvRowsEl.value, 10);
                if (Number.isFinite(n) && n >= 1) {
                    vscode.postMessage({ type: 'setDbmnSetting', key: 'execution.maxCsvRows', value: n });
                }
            }, 400);
        });

        // Dobermann issue 7: the log's age and size, saved a moment after typing stops, as maxCsvRows is
        [['logsKeepDays', 'logs.keepDays'], ['logsMostMegabytes', 'logs.mostMegabytes']].forEach(([id, key]) => {
            const input = document.getElementById(id);
            let timer = null;
            input?.addEventListener('input', () => {
                clearTimeout(timer);
                input.dataset.pending = 'true';
                timer = setTimeout(() => {
                    delete input.dataset.pending;
                    const n = parseInt(input.value, 10);
                    if (Number.isFinite(n) && n >= 1) vscode.postMessage({ type: 'setDbmnSetting', key, value: n });
                }, 400);
            });
        });

        // criticalErrorCodes — comma-separated, parse on blur (commit) or Enter.
        const codesEl = document.getElementById('criticalErrorCodes');
        const commitCodes = () => {
            if (!codesEl) return;
            const arr = codesEl.value
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0)
                .map(s => parseInt(s, 10))
                .filter(n => Number.isFinite(n) && n >= 100 && n <= 599);
            vscode.postMessage({ type: 'setDbmnSetting', key: 'execution.criticalErrorCodes', value: arr });
        };
        codesEl?.addEventListener('blur', commitCodes);
        codesEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCodes(); codesEl.blur(); }
        });

        // #342: a catalogue kept on this computer, saved to the DBMN account after all
        document.getElementById('catalogueSaveToAccount')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'saveCatalogueToAccount' });
        });
        // #427: signed out, the account's catalogue off this computer (asked first)
        document.getElementById('catalogueRemoveFromDevice')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'removeCatalogueFromDevice' });
        });

        // ── Workspace folder change ──────────────────────────────────────
        document.getElementById('changeWorkspaceFolder')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'selectWorkspaceFolder' });
        });

        // Knowing the path isn't the same as being able to look in it — especially after
        // changing folders, when "is my history in the old one?" is the whole question.
        document.getElementById('openWorkspaceFolder')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'openWorkspaceFolder' });
        });

        // Delegated handler for the system rows (rename / merge / delete).
        document.getElementById('hubSystemList')?.addEventListener('click', (e) => {
            const target = e.target.closest('[data-system-action]');
            if (!target) return;
            const action = target.dataset.systemAction;
            const systemId = target.dataset.systemId;
            if (!systemId) return;
            if (action === 'merge') {
                openSystemMergePicker(systemId);
                return;
            }
            vscode.postMessage({ type: action === 'rename' ? 'renameSystem' : 'deleteSystem', systemId });
        });
    }

    /**
     * Issue #275: pick a target System to merge `sourceId` into. Renders a
     * DbmnModal radio of the other Systems; the backend handler does the
     * reassignment + confirm + delete. No-op if the source vanished.
     */
    function openSystemMergePicker(sourceId) {
        const systems = hubState.systems || [];
        const source = systems.find(s => s.id === sourceId);
        if (!source) return;
        const targets = systems
            .filter(s => s.id !== sourceId)
            .slice()
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        if (targets.length === 0) return;
        if (!window.DbmnModal) return;

        window.DbmnModal.show({
            title: 'Merge System',
            body: `Move everything from "${source.name}" onto another System, then delete "${source.name}".`,
            fields: [{
                id: 'target',
                type: 'radio',
                label: 'Merge into',
                value: targets[0].id,
                options: targets.map(s => ({ value: s.id, label: s.name || '(unnamed)' }))
            }],
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'merge', label: 'Merge…', variant: 'danger' }
            ],
            dismissible: true,
            size: 'sm'
        }).then(result => {
            if (!result || result.actionId !== 'merge') return;
            const targetSystemId = result.fields && result.fields.target;
            if (!targetSystemId) return;
            // Backend shows the final destructive confirm (blast-radius counts).
            vscode.postMessage({ type: 'mergeSystem', systemId: sourceId, targetSystemId });
        });
    }

    // ─── Environments section ─────────────────────────────────────────────
    function wireEnvironmentsSection() {
        // Delegated handler — the list re-renders on every hubState push so
        // listeners on individual rows wouldn't survive. The add-row is
        // recognised by its dedicated class, env rows by data-env-id.
        // Issue #350: with no environments the list is hidden, so the empty state carries the
        // same Add (as the catalogue's "No endpoints yet" does).
        document.getElementById('hubAddEnvironmentEmpty')?.addEventListener('click', () => {
            vscode.postMessage({ type: 'addEnvironment' });
        });
        // Right-click an environment: Open, Rename (the one Rename dialog, hub-tabs.js)
        document.getElementById('hubEnvironmentList')?.addEventListener('contextmenu', (e) => {
            const row = e.target.closest('[data-env-id]');
            if (!row || !window.DbmnContextMenu) return;
            const env = (hubState.environments || []).find(x => x.id === row.dataset.envId);
            if (!env) return;
            window.DbmnContextMenu.show(e, [
                { id: 'open', label: 'Open', icon: 'server' },
                { id: 'rename', label: 'Rename', icon: 'pencil' }
            ], action => {
                if (action === 'open') row.click();
                else if (action === 'rename') {
                    if (window.HubTabs?.unsavedIn?.('environment', env.id)) {
                        window.DbmnToast?.warn('It has changes not saved: save or discard them, then rename it.');
                        return;
                    }
                    window.HubTabs?.askRename?.(env.name || '', 50).then(name => { if (name) vscode.postMessage({ type: 'renameEnvironment', environmentId: env.id, name }); });
                }
            });
        });
        document.getElementById('hubEnvironmentList')?.addEventListener('click', async (e) => {
            if (e.target.closest('#hubAddEnvironment')) {
                vscode.postMessage({ type: 'addEnvironment' });
                return;
            }
            const row = e.target.closest('[data-env-id]');
            if (!row) return;
            const newEnvId = row.dataset.envId;

            // Switching to a different env — ask the host to close whatever
            // is open in column 2 first. The Save/Discard/Cancel prompt fires
            // here, not after the optimistic highlight. Cancel (or a failed
            // save) aborts the swap so the previous editor + its highlight
            // both stay put.
            if (newEnvId !== selectedEnvId) {
                const ok = await requestCloseOpenEditors();
                if (!ok) return;
            }

            selectedEnvId = newEnvId;
            document.querySelectorAll('.hub-list-row.is-selected').forEach(r => r.classList.remove('is-selected'));
            row.classList.add('is-selected');
            vscode.postMessage({ type: 'openEnvironmentAsTab', environmentId: newEnvId });
        });
    }

    function renderEnvironmentsSection() {
        const list = document.getElementById('hubEnvironmentList');
        const empty = document.getElementById('hubEnvironmentEmpty');
        if (!list || !empty) return;

        const envs = (hubState.environments || []).slice().sort((a, b) =>
            (a.name || '').localeCompare(b.name || '')
        );
        if (envs.length === 0) {
            list.hidden = true;
            empty.hidden = false;
            return;
        }
        list.hidden = false;
        empty.hidden = true;
        list.innerHTML = '';

        // "Add" affordance sits at the top of the list — fast access without
        // header clutter. Same shape as the Catalogue's Add Endpoint row: a
        // plain row with one solid-outlined button centred in it. (There is no
        // "from clipboard" half here — environments aren't created that way.)
        const addRow = document.createElement('div');
        addRow.className = 'hub-list-row hub-list-row-add hub-add-split';
        addRow.innerHTML =
            '<div class="hub-add-split-group">' +
                '<button type="button" class="hub-add-split-primary" id="hubAddEnvironment">' +
                    '<span class="icon" data-icon="plus"></span>' +
                    '<span>Add Environment</span>' +
                '</button>' +
            '</div>';
        list.appendChild(addRow);

        envs.forEach(env => {
            const isActive = env.id === hubState.activeEnvironmentId;
            const isSelected = env.id === selectedEnvId;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'hub-list-row' +
                (isSelected ? ' is-selected' : '') +
                (isActive ? ' is-active-env' : '');
            row.dataset.envId = env.id;
            // Satellite-dish icon marks the env that actually executes API
            // requests. The row highlight (`is-selected`) marks what's open
            // in the editor — they're independent.
            const liveBadge = isActive
                ? '<span class="hub-list-row-live icon" data-icon="paw-print" title="Active environment"></span>'
                : '';
            row.innerHTML =
                '<div class="hub-list-row-text">' +
                    '<span class="hub-list-row-name"></span>' +
                    '<span class="hub-list-row-sub"></span>' +
                '</div>' +
                liveBadge;
            row.querySelector('.hub-list-row-name').textContent = env.name || '(unnamed)';
            const sub = [];
            if (env.baseUrl) sub.push(env.baseUrl);
            (Array.isArray(env.headerVariables) ? env.headerVariables : []).forEach(v => { if (v.value) sub.push('· ' + v.value); });
            row.querySelector('.hub-list-row-sub').textContent = sub.join(' ');
            list.appendChild(row);
        });

        if (window.Icons) window.Icons.injectIcons(list);
    }

    function renderSystemsSection() {
        const list = document.getElementById('hubSystemList');
        if (!list) return;
        const systems = (hubState.systems || []).slice().sort((a, b) =>
            (a.name || '').localeCompare(b.name || '')
        );

        list.innerHTML = '';
        if (systems.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'hub-system-empty';
            empty.textContent = 'No systems yet. Click "Add System" to create one.';
            list.appendChild(empty);
            return;
        }

        // Count endpoints + envs per System so we can show "empty / N items"
        // and gate the Delete affordance (mirrors the tree's delete guard).
        const endpointCounts = {};
        (hubState.endpoints || []).forEach(e => {
            const k = e.systemId || '__unknown__';
            endpointCounts[k] = (endpointCounts[k] || 0) + 1;
        });
        const envCounts = {};
        (hubState.environments || []).forEach(env => {
            const k = env.systemId || '__unknown__';
            envCounts[k] = (envCounts[k] || 0) + 1;
        });

        // Merge is only offered when there's at least one other System to
        // merge into (Issue #275).
        const canMerge = systems.length >= 2;

        systems.forEach(system => {
            const ec = endpointCounts[system.id] || 0;
            const vc = envCounts[system.id] || 0;
            const isEmpty = ec === 0 && vc === 0;
            const row = document.createElement('div');
            row.className = 'hub-system-row';
            // Two fixed action slots — merge, then delete — so the icons line
            // up down the whole list with no content shift (Issue #275). The
            // delete × is ALWAYS rendered; it's just disabled when the System
            // still has endpoints/environments linked (can't delete a non-empty
            // System — reassign or merge it first).
            const deleteTitle = isEmpty
                ? 'Delete'
                : 'Reassign or merge its endpoints/environments before deleting';
            // #415: a Standard System is set up by DBMN: no rename, merge or delete here (empty
            // slots keep the columns lined up). Others can still be merged into it.
            const standard = system.scope === 'global';
            row.innerHTML = standard
                ? '<span class="hub-system-row-name is-standard" title="A standard System, set up by DBMN"></span>' +
                  '<span class="hub-system-row-count"></span>' +
                  '<div class="hub-system-row-actions">' +
                      '<span class="hub-system-action-slot" aria-hidden="true"></span>' +
                      '<span class="hub-system-action-slot" aria-hidden="true"></span>' +
                  '</div>'
                :
                '<span class="hub-system-row-name" title="Click to rename"></span>' +
                '<span class="hub-system-row-count"></span>' +
                '<div class="hub-system-row-actions">' +
                    (canMerge
                        ? '<button type="button" class="btn btn-icon" data-system-action="merge" data-system-id="' + system.id + '" title="Merge into another System">' +
                              '<span class="icon" data-icon="git-merge"></span>' +
                          '</button>'
                        : '<span class="hub-system-action-slot" aria-hidden="true"></span>') +
                    '<button type="button" class="btn btn-icon" data-system-action="delete" data-system-id="' + system.id + '"' +
                        (isEmpty ? '' : ' disabled') + ' title="' + deleteTitle + '">' +
                        '<span class="icon" data-icon="x"></span>' +
                    '</button>' +
                '</div>';
            const nameEl = row.querySelector('.hub-system-row-name');
            nameEl.textContent = system.name || '(unnamed)';
            if (!standard) nameEl.addEventListener('click', () => startInlineRename(nameEl, system));
            row.querySelector('.hub-system-row-count').textContent =
                (standard ? 'Standard · ' : '') + `${ec} endpoint${ec === 1 ? '' : 's'} · ${vc} env${vc === 1 ? '' : 's'}`;
            list.appendChild(row);
        });

        if (window.Icons) window.Icons.injectIcons(list);
    }

    /**
     * Swap a system's name span for an inline input. Enter commits, Escape
     * cancels, blur commits. System IDs are stable so renaming only updates
     * the display name — endpoints + envs link to the System by id and need
     * no rewiring.
     */
    function startInlineRename(nameEl, system) {
        const original = system.name || '';
        const existingNames = (hubState.systems || [])
            .filter(s => s.id !== system.id)
            .map(s => (s.name || '').toLowerCase());

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'hub-system-row-name-input';
        input.value = original;
        input.maxLength = 16;
        input.spellcheck = false;
        input.autocomplete = 'off';

        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;

        function validate(raw) {
            const v = (raw || '').trim().toLowerCase();
            if (!v) return 'Required';
            if (v.length > 16) return 'Max 16 chars';
            if (!/^[a-z0-9]+$/.test(v)) return 'Use a-z 0-9 only';
            if (existingNames.indexOf(v) !== -1) return 'Name already in use';
            return undefined;
        }

        function commit() {
            if (committed) return;
            committed = true;
            const newName = input.value.trim().toLowerCase();
            const error = validate(newName);
            if (error || newName === original) {
                revertToSpan(original);
                if (error && newName !== original) {
                    showFooterNotification('warning', error, { shake: true });
                }
                return;
            }
            // Hand off to the backend; the upcoming hubState broadcast will
            // re-render this row with the new name.
            vscode.postMessage({ type: 'renameSystem', systemId: system.id, newName });
            revertToSpan(newName);
        }

        function cancel() {
            if (committed) return;
            committed = true;
            revertToSpan(original);
        }

        function revertToSpan(label) {
            const span = document.createElement('span');
            span.className = 'hub-system-row-name';
            span.title = 'Click to rename';
            span.textContent = label;
            span.addEventListener('click', () => startInlineRename(span, Object.assign({}, system, { name: label })));
            input.replaceWith(span);
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });
        input.addEventListener('input', () => {
            const err = validate(input.value);
            input.classList.toggle('is-invalid', !!err && input.value.trim().toLowerCase() !== original);
            input.title = err || '';
        });
        input.addEventListener('blur', commit);
    }

    function wireCatalogueAdd() {
        // The "+ New Endpoint" header button was removed — adding endpoints
        // from the Catalogue is now via the empty-state CTA only.
    }

    function notifyCatalogueSettings() {
        if (window.Catalogue) {
            window.Catalogue.applySettings({
                groupBy: document.getElementById('catalogueGroupBy')?.value,
                showRecent: document.getElementById('catalogueShowRecent')?.checked
            });
        }
    }

    function notifyTransactionsSettings() {
        if (window.Transactions) {
            window.Transactions.applySettings({
                showMode: document.getElementById('transactionsShow')?.value,
                groupBy: document.getElementById('transactionsGroupBy')?.value
            });
        }
    }

    function persistState(patch) {
        try {
            const prev = vscode.getState() || {};
            vscode.setState(Object.assign({}, prev, patch));
        } catch { /* webview state may be unavailable in some hosts */ }
    }

    function restoreState() {
        try {
            const state = vscode.getState() || {};
            // Persisted drawer width is a *preference*; applyLayout()
            // clamps it against the live Hub width (Issues #292, #349).
            const savedW = parseInt(state.hubCol2Width, 10);
            if (savedW > 0) preferredDrawerW = savedW;
            // `navCollapsed` predates #292 (rail form now follows has-tabs).
            if ('navCollapsed' in state) persistState({ navCollapsed: undefined });
            // Pre-fill the Settings controls with persisted values (if any).
            const groupCtrl = document.getElementById('catalogueGroupBy');
            if (groupCtrl && state.catalogueGroupBy) groupCtrl.value = state.catalogueGroupBy;
            const recentCtrl = document.getElementById('catalogueShowRecent');
            if (recentCtrl && typeof state.catalogueShowRecent === 'boolean') recentCtrl.checked = state.catalogueShowRecent;
            if (typeof state.showDesignSystem === 'boolean') showDesignSystem(state.showDesignSystem);
            const txShow = document.getElementById('transactionsShow');
            const txGroup = document.getElementById('transactionsGroupBy');
            if (txShow && state.transactionsShow) txShow.value = state.transactionsShow;
            if (txGroup && state.transactionsGroupBy) txGroup.value = state.transactionsGroupBy;
        } catch { /* ignore */ }
    }

    /** #373: the host's themes, in Settings › UI. Only a host that offers them shows the row. */
    // The theme picker in the header (shared/theme-picker.js): made when the host first offers
    // themes, so VS Code (which never does) has neither the button nor its dialog
    let themePicker = null;
    function updateThemePicker(message) {
        const offered = (message.options || []).length + (message.groups || []).length > 0;
        if (!themePicker && offered && window.ThemePicker) {
            themePicker = window.ThemePicker.create({
                button: document.getElementById('hubThemeBtn'),
                onPick: id => vscode.postMessage({ type: 'setTheme', id }),
                onHintDone: () => vscode.postMessage({ type: 'themeHintDone' }),
                icons: window.Icons
                    ? { close: window.Icons.icon('x'), prev: window.Icons.icon('chevron-left'), next: window.Icons.icon('chevron-right'), palette: window.Icons.icon('palette') }
                    : {},
                // The mock screens wear the Hub's own mark
                logo: document.querySelector('.hub-logo-mark')?.getAttribute('src') || ''
            });
        }
        if (themePicker) themePicker.update(message, { hint: !!message.hint });
    }

    // ── VS Code: DBMN's own theme over VS Code's ─────────────────────────
    // In VS Code (the host says `editorTheme`) Follow system is VS Code's theme as it comes, and
    // any other theme goes over it on DBMN's panels only. It goes on as a stylesheet of
    // `!important` properties, so VS Code's own (inline on the root, rewritten whenever its theme
    // changes) stay underneath, unchanged and readable: the host draws Follow system's card from
    // them. The tab frames copy the computed colours (tab-frame.js), so they wear it too.
    const EDITOR_PREVIEW_TOKENS = ['editor-background', 'sideBar-background', 'foreground', 'descriptionForeground', 'panel-border',
        'focusBorder', 'button-background', 'button-foreground', 'charts-green', 'charts-blue', 'charts-orange', 'charts-red', 'charts-purple'];
    const THEME_KINDS = ['vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light'];
    let editorThemed = false;
    let themeOverride = null;
    let editorKind = document.body.getAttribute('data-vscode-theme-kind') || 'vscode-dark';
    let themeStamp = 0;
    let editorReport = '';

    function wearKind(kind) {
        if (document.body.getAttribute('data-vscode-theme-kind') === kind && document.body.classList.contains(kind)) return;
        document.body.classList.remove(...THEME_KINDS);
        document.body.classList.add(kind);
        document.body.setAttribute('data-vscode-theme-kind', kind);
    }

    function paintThemeOverride() {
        let sheet = document.getElementById('dbmnThemeOverride');
        if (!themeOverride) {
            if (sheet) sheet.remove();
            wearKind(editorKind);
        } else {
            if (!sheet) {
                sheet = document.createElement('style');
                sheet.id = 'dbmnThemeOverride';
                document.head.append(sheet);
            }
            const safe = /^[^;{}<>]*$/;
            sheet.textContent = ':root{' + Object.entries(themeOverride.tokens || {})
                .filter(([name, value]) => /^--vscode-[\w-]+$/.test(name) && typeof value === 'string' && safe.test(value))
                .map(([name, value]) => name + ':' + value + ' !important;').join('') + '}';
            wearKind(themeOverride.kind === 'vscode-light' ? 'vscode-light' : 'vscode-dark');
        }
        // What the tab frames and Monaco watch, to copy the colours again
        document.documentElement.setAttribute('data-dbmn-theme', String(++themeStamp));
    }

    /** VS Code's own colours, for Follow system's card: sent when they change. */
    function reportEditorTheme() {
        if (!editorThemed) return;
        const root = document.documentElement.style;
        const tokens = {};
        for (const name of EDITOR_PREVIEW_TOKENS) {
            const value = root.getPropertyValue('--vscode-' + name).trim();
            if (value) tokens['--vscode-' + name] = value;
        }
        const report = JSON.stringify(tokens) + editorKind;
        if (report === editorReport) return;
        editorReport = report;
        vscode.postMessage({ type: 'editorTheme', tokens, dark: editorKind !== 'vscode-light' && editorKind !== 'vscode-high-contrast-light' });
    }

    function watchEditorTheme() {
        new MutationObserver(() => {
            // VS Code changed theme: its kind is the new one; ours goes back on over it
            const kind = document.body.getAttribute('data-vscode-theme-kind');
            const ours = themeOverride ? (themeOverride.kind === 'vscode-light' ? 'vscode-light' : 'vscode-dark') : null;
            if (kind && kind !== ours) editorKind = kind;
            if (themeOverride) wearKind(ours);
            reportEditorTheme();
        }).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
        new MutationObserver(reportEditorTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    }

    function applyEditorTheme(message) {
        if (!message.editorTheme) return;
        if (!editorThemed) {
            editorThemed = true;
            watchEditorTheme();
        }
        const next = message.applied && typeof message.applied === 'object' ? message.applied : null;
        if (JSON.stringify(next) !== JSON.stringify(themeOverride)) {
            themeOverride = next;
            paintThemeOverride();
        }
        reportEditorTheme();
    }

    function applyThemeOptions(message) {
        applyEditorTheme(message);
        updateThemePicker(message);
        const row = document.getElementById('uiThemeRow');
        const select = document.getElementById('uiTheme');
        if (!row || !select) return;
        const optionEl = option => {
            const el = document.createElement('option');
            el.value = option.id;
            el.textContent = option.label;
            return el;
        };
        const options = Array.isArray(message.options) ? message.options : [];
        const groups = Array.isArray(message.groups) ? message.groups : [];
        select.replaceChildren(...options.map(optionEl), ...groups.map(group => {
            const el = document.createElement('optgroup');
            el.label = group.label;
            el.append(...group.options.map(optionEl));
            return el;
        }));
        select.value = message.current;
        row.hidden = options.length + groups.length === 0;
        const help = document.getElementById('uiThemeHelp');
        if (help) help.textContent = message.help || '';
        // Follow system, where the computer only says light or dark: which theme each means
        for (const mode of ['light', 'dark']) {
            const modeRow = document.getElementById(mode === 'light' ? 'uiThemeLightRow' : 'uiThemeDarkRow');
            const modeSelect = document.getElementById(mode === 'light' ? 'uiThemeLight' : 'uiThemeDark');
            if (!modeRow || !modeSelect) continue;
            const offered = message.system ? message.system[mode] : null;
            modeRow.hidden = !offered;
            if (!offered) continue;
            modeSelect.replaceChildren(...offered.options.map(optionEl));
            modeSelect.value = offered.current;
        }
    }

    function applyDbmnSettings(settings) {
        if (!settings) return;
        const setToggle = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setToggle('autoOpenConsole', settings.autoOpenConsoleOnCompletion);
        setToggle('treatNetworkErrorsAsCritical', settings.treatNetworkErrorsAsCritical);
        setToggle('confirmTransactionDeletion', settings.confirmTransactionDeletion);
        setToggle('telemetryEnabled', settings.telemetryEnabled !== false);
        // #419: Weekly Usage says why it is empty when sharing is off
        document.body.classList.toggle('telemetry-off', settings.telemetryEnabled === false);
        if (window.HubAccount && window.HubAccount.refreshUsageState) window.HubAccount.refreshUsageState();

        const maxRows = document.getElementById('maxCsvRows');
        // Only update if the user isn't typing in it — don't yank the value out from under
        // them. A window in the background keeps its focused field, but nobody is typing
        // there: a change from another device must still show (#281, 2026-10-10).
        const typingIn = el => document.hasFocus() && document.activeElement === el;
        [['logsKeepDays', settings.logsKeepDays], ['logsMostMegabytes', settings.logsMostMegabytes]].forEach(([id, value]) => {
            const input = document.getElementById(id);
            if (input && !typingIn(input) && !input.dataset.pending && value != null) input.value = String(value);
        });
        if (maxRows && !typingIn(maxRows) && !maxRows.dataset.pending && settings.maxCsvRows != null) {
            maxRows.value = String(settings.maxCsvRows);
        }
        const codes = document.getElementById('criticalErrorCodes');
        if (codes && !typingIn(codes) && Array.isArray(settings.criticalErrorCodes)) {
            codes.value = settings.criticalErrorCodes.join(', ');
        }
    }

    /**
     * #342: Settings › Endpoints › Stored. `storage` is { label, help, saveLabel?, removeLabel? }
     * from the host: where the signed-in user's catalogue lives, and (on this computer only) the
     * button that saves it to their account. Signed out with the account's copy (#427), the
     * button that removes it from this computer. Absent: the row is hidden.
     */
    function applyCatalogueStorage(storage) {
        const row = document.getElementById('catalogueStorageRow');
        if (!row) return;
        row.classList.toggle('hidden', !storage);
        if (!storage) return;
        const where = document.getElementById('catalogueStorageWhere');
        const help = document.getElementById('catalogueStorageHelp');
        const save = document.getElementById('catalogueSaveToAccount');
        if (where) where.textContent = storage.label || '';
        if (help) help.textContent = storage.help || '';
        if (save) {
            save.classList.toggle('hidden', !storage.saveLabel);
            if (storage.saveLabel) save.textContent = storage.saveLabel;
        }
        const remove = document.getElementById('catalogueRemoveFromDevice');
        if (remove) {
            remove.classList.toggle('hidden', !storage.removeLabel);
            if (storage.removeLabel) remove.textContent = storage.removeLabel;
        }
    }

    function applyWorkspaceInfo(info) {
        const wsEl = document.getElementById('workspacePath');
        const dbEl = document.getElementById('executionsDbPath');
        if (wsEl) wsEl.textContent = (info && info.workspacePath) || '— (not configured)';
        if (dbEl) dbEl.textContent = (info && info.executionsDbPath) || '— (workspace not configured)';
        // The web app (#344): where History lives, what the button does, no "Open folder"
        const help = document.getElementById('workspaceFolderHelp');
        if (help && info && info.note) help.textContent = info.note;
        const choose = document.getElementById('changeWorkspaceFolder');
        if (choose && info && info.chooseLabel) choose.textContent = info.chooseLabel;
        const reveal = document.getElementById('openWorkspaceFolder');
        if (reveal) reveal.classList.toggle('hidden', !!info && info.canReveal === false);
    }

    // Thin wrapper kept for the existing call sites. The old in-flow footer
    // notification shifted content and looked broken when space was tight; it's
    // replaced by the fixed-overlay DbmnToast (which also styles all four levels,
    // fixing the previously-invisible 'success'). Options map 1:1 except
    // `duration` → `durationMs`.
    function showFooterNotification(type, message, options = {}) {
        if (!window.DbmnToast) return;
        window.DbmnToast.show(type, message, {
            durationMs: options.duration,
            persistent: options.persistent,
            shake: options.shake,
            dismissible: options.dismissible
        });
    }

    /** Derive `{ done, total }` from a transaction so the tab's progress
     *  bar can fill while a batch runs. For individuals there's no
     *  meaningful progress, so we return null and the tab just shows the
     *  status icon. */
    function computeTabProgress(tx) {
        if (!tx || tx.executionType !== 'batch') return null;
        const total = tx.preparationState?.totalTransactions
            || tx.preparationState?.totalRows
            || 0;
        const r = tx.batchResumptionData;
        const rawDone = (r?.completedExecutions?.length || 0)
            + (r?.failedExecutions?.length || 0)
            + (r?.skippedExecutions?.length || 0);
        if (!total && !rawDone) return null;
        // Clamp to total — a stopped/failed run can list the same execution in
        // more than one bucket (e.g. completed + failed), which produced counts
        // like "2/1". You can never process more than the batch size.
        const done = total ? Math.min(rawDone, total) : rawDone;
        return { done, total };
    }

    function progressEqual(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        return a.done === b.done && a.total === b.total;
    }

    /** Apply a Hub state payload (from either the inline
     *  `window.__HUB_INITIAL_STATE__` seeded at first paint or the runtime
     *  `hubState` postMessage) to the global `hubState` + every section
     *  renderer. Idempotent — safe to run on first paint AND again when the
     *  backend posts an updated state. */
    /** #298: Reporting's rail item and Home guide link show only while its feature flag is on. */
    function applyHubState(message) {
        if (!message) return;
        // Lazy-open path (no inline state at first paint): the preferences
        // arrive with the first hubState broadcast, after init() ran.
        if (seedStateFromHost(message.hubPreferences)) {
            restoreState();
            notifyCatalogueSettings();
            notifyTransactionsSettings();
        }
        hubState = {
            endpoints: message.endpoints || [],
            // MRU touches (save only; runs come via transactions) for the catalogue's Recent section.
            recentEndpoints: message.recentEndpoints || [],
            systems: message.systems || [],
            environments: message.environments || [],
            transactions: message.transactions || [],
            // #298: the compares run, one per endpoint, for the Compare list
            compares: message.compares || [],
            // The saved queries, on the same list
            queries: message.queries || [],
            // The lookup tables, on the same list (Reporting's): without them here the list never shows one
            lookupTables: message.lookupTables || [],
            activeEnvironmentId: message.activeEnvironmentId,
            activeSystemId: message.activeSystemId,
            // Drives the catalogue's run-control visibility — execution requires
            // a signed-in DBMN identity for telemetry attribution.
            isSignedIn: message.isSignedIn,
            // Issue #396: signed in, but the session can no longer refresh
            dbmnSessionExpired: message.dbmnSessionExpired === true
        };

        applyDbmnSettings(message.dbmnSettings);
        applyWorkspaceInfo(message.workspaceInfo);
        applyCatalogueStorage(message.catalogueStorage);
        renderEnvSelector();
        renderEnvironmentsSection();
        renderSystemsSection();
        if (window.Catalogue) {
            window.Catalogue.update(hubState);
        }
        if (window.Transactions) {
            window.Transactions.update(hubState);
        }
        if (window.CompareList) {
            window.CompareList.update(hubState);   // #298
        }
        // (a query's tab wears Compare's icon once it is a compare, as its row in the list does)
        if (window.HubTabs?.setQueries) {
            window.HubTabs.setQueries(hubState.queries);
        }
        if (window.HubActivity?.update) {
            window.HubActivity.update();
        }
        // Push live status + progress into any open Console tab.
        // Each console tab is keyed `console:{executionId}` or
        // `batchConsole:{executionId}`. We look up each open tab's
        // transaction in the freshly-broadcast state and call
        // HubTabs.setStatus to update the icon + progress bar.
        if (window.HubTabs?.getState && hubState.transactions) {
            const open = window.HubTabs.getState().tabs || [];
            const txById = new Map();
            for (const t of hubState.transactions) {
                const id = t.id || t.executionId;
                if (id) txById.set(id, t);
            }
            for (const tab of open) {
                if (!tab.type || (tab.type !== 'console' && tab.type !== 'batchConsole')) continue;
                const refId = tab.refId || tab.id.split(':').slice(1).join(':');
                const tx = txById.get(refId);
                if (!tx) continue;
                const status = String(tx.status || '').toLowerCase();
                // The transaction record has NO live per-member progress —
                // the engine holds it in-memory and streams it via the
                // setTabStatus (peek) path. This broadcast snapshot is
                // stale/0 mid-run, so it must NOT clobber the live bar.
                const persisted = computeTabProgress(tx);
                const live = tab.progress;
                const hasLive = !!(live && (live.done || live.total));
                // Merge monotonically so a stale snapshot never regresses
                // a live count.
                let progress = persisted;
                if (hasLive) {
                    progress = persisted
                        ? { done: Math.max(persisted.done || 0, live.done || 0),
                            total: Math.max(persisted.total || 0, live.total || 0) }
                        : live;
                }
                // Peek owns ACTIVE tabs. Only drive the tab from here for
                // terminal states, or to seed a tab with no live data yet
                // (e.g. a finished run opened from History).
                const terminal = status === 'completed' || status === 'cancelled'
                    || status === 'stopped' || status === 'failed';
                if (!terminal && hasLive) continue;
                if ((status && status !== tab.status) || !progressEqual(progress, tab.progress)) {
                    window.HubTabs.setStatus(tab.id, status, progress);
                }
            }
        }
    }

    function handleMessage(event) {
        const message = event.data || {};
        // Tab-system messages (mount / focus / payload-to-tab) route through
        // HubTabs. Short-circuit before the section switch so other handlers
        // don't see these envelopes.
        if (window.HubTabs && window.HubTabs.handleHostMessage(message)) return;
        switch (message.type) {
            case 'hubState':
                applyHubState(message);
                break;
            case 'themeOptions':
                applyThemeOptions(message);
                break;
            case 'headerVariablesPicked': {
                // #424: a header pick (or Add) drawn at once; the full state follows when it is saved
                const env = (hubState.environments || []).find(e => e.id === message.environmentId);
                if (env && Array.isArray(message.headerVariables)) {
                    env.headerVariables = message.headerVariables;
                    hubState.activeEnvironmentId = env.id;
                    renderEnvSelector();
                }
                break;
            }
            case 'activeEnvironmentPicked':
                // A switch drawn at once (name, header colour, its variables); the full state
                // follows when it is saved (2026-11-16: "annoyingly SLOW")
                if ((hubState.environments || []).some(e => e.id === message.environmentId)) {
                    hubState.activeEnvironmentId = message.environmentId;
                    renderEnvSelector();
                }
                break;
            case 'setActiveEnvironmentError':
                // Switching environment or saving a header pick failed: say so (the state is put back)
                if (window.DbmnToast) window.DbmnToast.show('error', message.error || 'That change wasn\'t saved.');
                break;
            case 'agentConnection':
                // #344: is DBMN for VS Code there? Only a host that reaches VS Code (the web app) says
                agentConnection = message.state;
                renderEnvSelector();
                break;
            case 'startupRecovery':
                // Issue #313: what recovery paused after VS Code closed — our toast, with
                // a link to History where each paused batch has its Resume.
                if (message.message && window.DbmnToast) {
                    window.DbmnToast.show('info', message.message, {
                        persistent: true,
                        link: { text: 'Open History', onClick: () => { void switchSection('transactions'); } }
                    });
                }
                break;
            case 'navigateToSection':
                // Host-driven section switch (e.g. startup-recovery's "View"
                // button lands the user on History). switchSection respects
                // unsaved-editor guards; on a cold open there are none.
                if (message.section) void switchSection(message.section);
                break;
            // 'setTabStatus' never reaches here: HubTabs.handleHostMessage takes it
            // (and, since Issue #312, mirrors its progress into the Activity drawer).
            case 'createSystemError':
                showFooterNotification('error', 'Could not create System: ' + message.error, { shake: true });
                break;
            case 'renameSystemError':
                showFooterNotification('error', 'Could not rename System: ' + message.error, { shake: true });
                break;
            case 'closeEditorsResult':
                if (closeEditorsResolver) {
                    const ok = !!message.ok;
                    const resolver = closeEditorsResolver;
                    closeEditorsResolver = null;
                    resolver(ok);
                }
                break;
            case 'editorClosed':
                handleEditorClosed(message.context);
                break;
            case 'swapResult':
                // Host confirms whether a Catalogue row's open/run actually
                // landed (success) or was aborted (Cancel in unsaved-changes
                // prompt). On abort, the Catalogue reverts the optimistic
                // row highlight to whatever's actually still open.
                if (window.Catalogue?.handleSwapResult) {
                    window.Catalogue.handleSwapResult(message);
                }
                break;
            // `dbmnModalRequest` is now handled by the auto-bridge inside
            // dbmn-modal.js — no explicit handler needed here.
            case 'tagManagerData':
                if (window.HubTagManager?.onTagsData) {
                    window.HubTagManager.onTagsData(message.tags || []);
                }
                break;
            case 'tagOpComplete':
                // #432: an open endpoint editor shows the tags as they are now (a renamed tag's
                // old chip, saved again, would bring it back)
                if (window.HubTabs?.tellTabs) window.HubTabs.tellTabs('endpoint', { type: 'tagsChanged' });
                if (message.summary) {
                    const op = message.op || 'op';
                    const touched = message.summary.endpointsTouched || 0;
                    showFooterNotification('success',
                        `${op === 'rename' ? 'Renamed' : op === 'merge' ? 'Merged' : 'Deleted'} ` +
                        `tag across ${touched} endpoint${touched === 1 ? '' : 's'}.`);
                }
                break;
            case 'systemCreated':
                if (window.Catalogue) {
                    window.Catalogue.acknowledgeSystemCreated(message.systemId);
                }
                break;
            case 'historyAll':
                window.Transactions?.onHistoryAll?.(message);
                break;
            case 'transactionContentSearchResult':
                // Issue #246: backend matched the search term against the
                // request/response body files for the candidate id set.
                window.Transactions?.onContentSearchResult?.(message);
                break;
        }
    }

    /**
     * The design system's page, from a button in the header. Settings → UI → Design system turns
     * the button on for anyone; a development build (the one with the DEV pill) has it on until
     * the setting says otherwise.
     */
    function showDesignSystem(on) {
        const button = document.getElementById('hubDesignBtn');
        const toggle = document.getElementById('showDesignSystem');
        if (button) button.hidden = !on;
        if (toggle) toggle.checked = !!on;
    }
    function wireDesignSystem() {
        const button = document.getElementById('hubDesignBtn');
        const toggle = document.getElementById('showDesignSystem');
        if (!button) return;
        button.addEventListener('click', () => vscode.postMessage({ type: 'openDesignSystem' }));
        showDesignSystem(!!document.querySelector('.hub-header .hub-dev-backend'));
        toggle?.addEventListener('change', () => {
            persistState({ showDesignSystem: toggle.checked });
            showDesignSystem(toggle.checked);
        });
    }

    /**
     * "New compare engine (testing)": the engine is on in every build (James, 2026-11-22); this switch,
     * a development build's only, turns it off to compare with the old one until that is removed.
     */
    function wireNewCompareEngine() {
        const row = document.getElementById('newCompareEngineRow');
        const toggle = document.getElementById('newCompareEngine');
        if (!row || !toggle) return;
        row.hidden = !document.querySelector('.hub-header .hub-dev-backend');
        try { toggle.checked = (vscode.getState() || {}).newCompareEngine !== false; } catch { toggle.checked = true; }
        toggle.addEventListener('change', () => persistState({ newCompareEngine: toggle.checked }));
    }

    function init() {
        // Hydrate all [data-icon] placeholders before anything else paints.
        if (window.Icons) window.Icons.injectIcons();

        wireNav();
        wireDesignSystem();
        wireNewCompareEngine();
        wireRailMore();
        wireEnvSelector();
        wireSettings();
        wireEnvironmentsSection();
        wireCatalogueAdd();
        seedStateFromHost(window.__HUB_INITIAL_STATE__?.hubPreferences);
        restoreState();

        // Tab system — owns the content area. With no tabs open it shows
        // Home and the rail keeps its labels (no `has-tabs` class yet).
        if (window.HubTabs) {
            window.HubTabs.init();
            // renderStrip subscribes first inside init(), so `has-tabs` is
            // already current when the layout pass runs.
            window.HubTabs.subscribe(applyLayout);
            window.HubTabs.subscribe(syncRail);
        }
        applyLayout();
        syncRail();

        if (window.Catalogue) {
            window.Catalogue.init({
                postMessage: (msg) => vscode.postMessage(msg),
                getState: () => hubState,
                getInitialSettings: () => {
                    try {
                        const state = vscode.getState() || {};
                        return {
                            groupBy: state.catalogueGroupBy,
                            showRecent: state.catalogueShowRecent,
                            recentCollapsed: state.catalogueRecentCollapsed
                        };
                    } catch { return {}; }
                }
            });
        }

        if (window.HubActivity?.init) {
            window.HubActivity.init({
                postMessage: (msg) => vscode.postMessage(msg),
                getState: () => hubState
            });
        }

        if (window.CompareList) {
            window.CompareList.init({ postMessage: (msg) => vscode.postMessage(msg) });   // #298
        }
        if (window.Transactions) {
            window.Transactions.init({
                postMessage: (msg) => vscode.postMessage(msg),
                getState: () => hubState,
                getInitialSettings: () => {
                    try {
                        const state = vscode.getState() || {};
                        return {
                            transactionsShow: state.transactionsShow,
                            transactionsGroupBy: state.transactionsGroupBy,
                            transactionsEnvFilter: state.transactionsEnvFilter,
                            transactionsSysFilter: state.transactionsSysFilter,
                            transactionsStatusFilters: state.transactionsStatusFilters,
                            transactionsMethodFilters: state.transactionsMethodFilters,
                            transactionsEndpointFilter: state.transactionsEndpointFilter
                        };
                    } catch { return {}; }
                }
            });
        }

        // Home — the tab area with no tabs open (Issue #348).
        if (window.HubHome) {
            window.HubHome.init();
        }

        if (window.HubTagManager) {
            window.HubTagManager.init({
                postMessage: (msg) => vscode.postMessage(msg)
            });
        }

        // Settings → Manage Tags button.
        document.getElementById('hubOpenTagManager')?.addEventListener('click', () => {
            if (window.HubTagManager) window.HubTagManager.requestOpen();
        });

        // Embedded import/export flow — wires its own event listeners against
        // the IDs that now live in the Hub's Import / Export sections.
        if (window.HubImportExport) {
            window.HubImportExport.init();
        }

        // Embedded account flow — same headless-delegate pattern as
        // import/export. Wired after the section markup is in the DOM.
        if (window.HubAccount) {
            window.HubAccount.init();
        }

        window.addEventListener('message', handleMessage);

        // Workbench chord forwarding — Ctrl/Cmd chords don't reliably
        // reach VS Code's keybinding service when focus is inside a
        // webview (worse from a nested iframe). Capture-phase document
        // listener maps chord → workbench command and posts to the host,
        // which executes it. Same forwarder is injected into every
        // embedded tab iframe (hub-tabs.js shim), so deep focus (form
        // field, catalogue row, tab body) all work. Capture on `document`
        // runs before anything deeper in the tree, Monaco included, so a
        // mapped chord means the same thing wherever focus is — that
        // consistency is the point. Everything NOT in the map (Ctrl+F find,
        // Ctrl+/, Ctrl+D, the editing chords) is untouched and still
        // belongs to whatever has focus. Keep in sync with the allowlist in
        // hub-manager.ts and the map in hub-tabs.js.
        const WORKBENCH_CHORD_MAP = {
            'p':       'workbench.action.quickOpen',
            'p:shift': 'workbench.action.showCommands',
            'n':       'workbench.action.files.newUntitledFile',
            'o':       'workbench.action.files.openFile',
            'b':       'workbench.action.toggleSidebarVisibility',
            'j':       'workbench.action.togglePanel',
            '`':       'workbench.action.terminal.toggleTerminal',
            ',':       'workbench.action.openSettings',
            'e:shift': 'workbench.view.explorer',
            'f:shift': 'workbench.action.findInFiles',
            'g:shift': 'workbench.view.scm',
            'x:shift': 'workbench.view.extensions',
            'd:shift': 'workbench.view.debug'
        };
        document.addEventListener('keydown', (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            const cmd = WORKBENCH_CHORD_MAP[e.shiftKey ? key + ':shift' : key];
            if (!cmd) return;
            e.preventDefault();
            e.stopPropagation();
            vscode.postMessage({ type: 'runWorkbenchCommand', command: cmd });
        }, true);

        // Synchronously hydrate from the inline state embedded by
        // hub-manager.getHtmlContent() so the first paint shows a populated
        // UI — no empty-shell flash, no `ready`→`hubState` round-trip gap.
        // The backend still re-broadcasts on `ready`; applyHubState is
        // idempotent so the second pass just refreshes with the same data.
        if (window.__HUB_INITIAL_STATE__) {
            try { applyHubState(window.__HUB_INITIAL_STATE__); } catch (_e) { /* swallow */ }
        }

        vscode.postMessage({ type: 'ready' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

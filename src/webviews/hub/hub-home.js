// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Hub Home (GitHub Issue #348)
 *
 * What the tab area shows when no tabs are open, and so what every launch
 * opens on: the Hub no longer restores the last session's tabs by itself.
 *   - Pick up where you left off: re-open the previous session's tabs
 *   - Puppy School, front and centre until the learner graduates
 *   - Quick start, and "New in vX.Y.Z" from the bundled changelog
 *   - This week's usage, and a tip
 * hub.css hides Home while `.hub-layout.has-tabs` is set.
 *
 * Display only. Every action reuses a message or path the Hub already has:
 *   - Add Endpoint / New Endpoint from Clipboard → `addEndpoint` (as the catalogue's add row)
 *   - Add Environment → `addEnvironment`
 *   - Import          → the Import page tab (HubLayout.switchSection)
 *   - Puppy School    → `openPuppySchool` (as Account's button)
 *   - Re-open tabs    → `reopenTabs` (hub-manager restorePersistedTabs)
 *   - links           → `openExternalUrl`
 *   - the guide       → a rail item's own action (HubLayout.switchSection):
 *                       the rail is icons only, so Home names them, level
 *                       with each icon
 *
 * Host messages it follows: `hubHomeInfo` (re-open offer + what's new),
 * `badgeStateUpdate` (Puppy School) and `authStateUpdate` (This week) — the
 * last two are the messages Account renders, so Home adds no network calls.
 */
(function () {
    'use strict';

    /** Shipped with the extension. Terse, one idea each, true of the product. */
    const TIPS = [
        'Press ? then click any control to read what it does.',
        'Close all tabs, at the end of the tab bar, keeps anything unsaved open: edited endpoints and environments, and Run Batch data you haven’t run.',
        'Click an endpoint to preview it in a tab. Double-click to keep the tab.',
        'Copy to Share puts an endpoint on your clipboard. New Endpoint from Clipboard turns it back into one.',
        'Right-click a run in History to act on it without opening it.',
        'Drag the edge of the list panel to widen it. The Hub remembers the width.',
        'Alt+W closes the active tab.',
        'A production environment highlights the header as a warning, so you always know where requests go.',
        'Click a rail item a second time to close its list panel.'
    ];

    const LESSON_COUNT = 5;
    /** Tips move on by themselves; ‹ › restarts the wait. */
    const TIP_INTERVAL_MS = 15_000;
    /** Matches the .hub-home-tip-line transition in hub.css. */
    const TIP_SLIDE_MS = 160;
    let tipTimer = null;
    let tipSlideTimer = null;
    const GRADUATE_BADGE = 'ps_graduate';

    let tipIndex = 0;

    function post(msg) {
        window.vscode?.postMessage(msg);
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : many);
    }

    function formatDate(iso) {
        try {
            return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        } catch {
            return String(iso).slice(0, 10);
        }
    }

    /* ─── Pick up where you left off ──────────────────────────────────── */

    /**
     * The web app's workspace folder (#344): `home` is { title, text, button } while it isn't
     * using the folder (never chosen, or the browser needs permission again); absent otherwise,
     * and always absent in VS Code.
     */
    function renderWorkspace(info) {
        const card = document.getElementById('hubHomeWorkspace');
        if (!card) return;
        const home = info && info.home;
        card.classList.toggle('hidden', !home);
        if (!home) return;
        setText('hubHomeWorkspaceTitle', home.title);
        setText('hubHomeWorkspaceText', home.text);
        setText('hubHomeWorkspaceBtn', home.button);
    }

    /**
     * #342: the catalogue is on this computer only (the user's choice). `storage.home` is
     * { title, text, button } while Home should encourage saving it to the account; absent
     * once it is there and signed out. In the web app it is { title, text } for a VS Code
     * user whose catalogue is still on their computer.
     */
    function renderCatalogueStorage(storage) {
        const card = document.getElementById('hubHomeCatalogue');
        if (!card) return;
        const home = storage && storage.home;
        card.classList.toggle('hidden', !home);
        if (!home) return;
        setText('hubHomeCatalogueTitle', home.title);
        setText('hubHomeCatalogueText', home.text);
        setText('hubHomeCatalogueBtn', home.button || '');
        // No button when the save happens elsewhere (the web app's card for a VS Code user)
        const button = document.getElementById('hubHomeCatalogueBtn');
        if (button) { button.classList.toggle('hidden', !home.button); button.hidden = !home.button; }
    }

    /** `reopen` is { count, names } or null once there is nothing to offer. */
    function renderReopen(reopen) {
        const card = document.getElementById('hubHomeReopen');
        if (!card) return;
        card.classList.toggle('hidden', !reopen || !reopen.count);
        if (!reopen || !reopen.count) return;
        const names = Array.isArray(reopen.names) ? reopen.names : [];
        const shown = names.slice(0, 4).join(' · ');
        setText('hubHomeReopenNames', names.length > 4 ? shown + ' and ' + (names.length - 4) + ' more' : shown);
        setText('hubHomeReopenBtn', 'Re-open ' + plural(reopen.count, 'tab', 'tabs'));
    }

    /* ─── New in vX.Y.Z ───────────────────────────────────────────────── */

    /** `whatsNew` is summariseChangelog()'s result (whats-new.ts) or null. */
    function renderWhatsNew(whatsNew) {
        const card = document.getElementById('hubHomeWhatsNew');
        if (!card) return;
        card.classList.toggle('hidden', !whatsNew);
        if (!whatsNew) return;
        setText('hubHomeWhatsNewTitle', !whatsNew.version ? 'Coming next'
            : whatsNew.versions > 1 && whatsNew.since ? 'New since v' + whatsNew.since
            : 'New in v' + whatsNew.version);
        const c = whatsNew.counts || {};
        const parts = [];
        if (c.added) parts.push(plural(c.added, 'new feature', 'new features'));
        if (c.fixed) parts.push(plural(c.fixed, 'fix', 'fixes'));
        if (c.changed) parts.push(plural(c.changed, 'change', 'changes'));
        if (c.security) parts.push(plural(c.security, 'security fix', 'security fixes'));
        setText('hubHomeWhatsNewCounts', parts.join(' · '));
        const list = document.getElementById('hubHomeWhatsNewList');
        if (list) {
            list.textContent = '';
            (whatsNew.highlights || []).forEach(title => {
                const li = document.createElement('li');
                li.textContent = title;
                list.appendChild(li);
            });
        }
    }

    /* ─── This week ──────────────────────────────────────────────────── */

    /** Same format as Account's Weekly Usage (account-frontend.js). */
    function formatRunTime(ms) {
        if (!ms || ms <= 0) return '0s';
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return days + 'd ' + (hours % 24) + 'h';
        if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
        if (minutes > 0) return minutes + 'm ' + (seconds % 60) + 's';
        return seconds + 's';
    }

    function formatCount(n) {
        return Number(n || 0).toLocaleString();
    }

    /** Host's `authStateUpdate`. Hidden while signed out or with no numbers yet. */
    function renderWeek(state) {
        const card = document.getElementById('hubHomeWeek');
        if (!card) return;
        const weekly = state && state.isAuthenticated && state.telemetryStats ? state.telemetryStats.weekly : null;
        card.classList.toggle('hidden', !weekly);
        if (!weekly) return;
        setText('hubHomeWeekLabel', state.usage && state.usage.weekStart ? 'Week of ' + state.usage.weekStart : '');
        setText('hubHomeApiCalls', formatCount(weekly.apiCalls));
        setText('hubHomeBatchRuns', formatCount(weekly.batchRuns));
        setText('hubHomeRowsProcessed', formatCount(weekly.rowsProcessed));
        setText('hubHomeRunTime', formatRunTime(weekly.totalExecutionTimeMs));
    }

    /* ─── Puppy School ────────────────────────────────────────────────── */

    function badgeTile(id, caption, earnedAt, description) {
        const earned = !!earnedAt;
        const item = document.createElement('div');
        item.className = 'dbmn-badge hub-home-badge' + (earned ? '' : ' dbmn-badge-locked');
        item.setAttribute('role', 'listitem');
        item.dataset.badgeId = id;
        item.title = earned
            ? caption + ' — earned ' + formatDate(earnedAt)
            : caption + ' — ' + (description || 'not earned yet');
        const art = document.createElement('div');
        art.className = 'dbmn-badge-art';
        // Trusted, bundled SVG keyed by id — never markup from the message.
        art.innerHTML = !window.Badges ? '' : earned ? window.Badges.badgeSvg(id) : window.Badges.lockedSvg(id);
        const name = document.createElement('div');
        name.className = 'dbmn-badge-name';
        name.textContent = caption;
        item.appendChild(art);
        item.appendChild(name);
        return item;
    }

    /** Host's `badgeStateUpdate` (badge.service.ts), or nothing yet (signed
     *  out, first paint): five outlines and "Start Puppy School". Until
     *  graduation, the lesson badges with earned ones in colour; after it,
     *  the graduate badge and the date. */
    function renderPuppySchool(message) {
        const state = message && message.state;
        const graduatedAt = state && state.puppySchool ? state.puppySchool.graduatedAt : null;
        const badges = state && Array.isArray(state.badges) ? state.badges : [];

        const pill = document.getElementById('hubHomePuppyProgress');
        if (pill) {
            pill.textContent = (message && message.progressLabel) || 'Not started';
            pill.className = 'status-pill-generic' + (graduatedAt ? ' success' : '');
        }
        setText('hubHomePuppyBtn', (message && message.actionLabel) || 'Start Puppy School');
        document.getElementById('hubHomePuppy')?.classList.toggle('is-graduated', !!graduatedAt);
        document.getElementById('hubHomePuppyLearning')?.classList.toggle('hidden', !!graduatedAt);
        document.getElementById('hubHomeGraduate')?.classList.toggle('hidden', !graduatedAt);

        if (graduatedAt) {
            const art = document.getElementById('hubHomeGraduateArt');
            if (art) art.innerHTML = window.Badges ? window.Badges.badgeSvg(GRADUATE_BADGE) : '';
            setText('hubHomeGraduateText', 'Graduated ' + formatDate(graduatedAt));
            return;
        }

        const row = document.getElementById('hubHomeBadges');
        if (!row) return;
        row.textContent = '';
        const lessons = badges.filter(b => b.id !== GRADUATE_BADGE);
        if (lessons.length === 0) {
            for (let i = 1; i <= LESSON_COUNT; i++) row.appendChild(badgeTile('ps_lesson_' + i, 'Lesson ' + i, null, ''));
            return;
        }
        lessons.forEach(b => {
            const caption = (message.captions && message.captions[b.id]) || b.name;
            row.appendChild(badgeTile(b.id, caption, b.earnedAt, b.description));
        });
    }

    /* ─── Tip ─────────────────────────────────────────────────────────── */

    function dayNumber() {
        const now = new Date();
        return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
    }

    /**
     * Shows the current tip. With a direction the old line scrolls out and
     * the new one scrolls in from the opposite edge (next: up, previous:
     * down); without one the text just changes, as on first paint.
     */
    function renderTip(direction) {
        const line = document.querySelector('#hubHomeTipText .hub-home-tip-line');
        if (!line) return;
        clearTimeout(tipSlideTimer);
        if (!direction) {
            line.textContent = TIPS[tipIndex];
            return;
        }
        const out = direction > 0 ? 'hub-home-tip-line-up' : 'hub-home-tip-line-down';
        const from = direction > 0 ? 'hub-home-tip-line-down' : 'hub-home-tip-line-up';
        line.classList.add(out);
        tipSlideTimer = setTimeout(() => {
            // Jump (no transition) to the far edge with the new text, then let it roll in.
            line.classList.add('hub-home-tip-line-still', from);
            line.classList.remove(out);
            const text = line.parentElement;
            const before = text.offsetHeight;
            line.textContent = TIPS[tipIndex];
            easeHeight(text, before);
            line.classList.remove('hub-home-tip-line-still', from);
        }, TIP_SLIDE_MS);
    }

    /** A tip on more lines (or fewer) grows the card through the heights between, not in a jump. */
    function easeHeight(el, before) {
        const after = el.offsetHeight;
        if (after === before || typeof el.animate !== 'function') return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        el.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: TIP_SLIDE_MS, easing: 'ease' });
    }

    function stepTip(delta) {
        tipIndex = (tipIndex + delta + TIPS.length) % TIPS.length;
        renderTip(delta);
        clearInterval(tipTimer);
        tipTimer = setInterval(() => stepTip(1), TIP_INTERVAL_MS);
    }

    /* ─── Wiring ──────────────────────────────────────────────────────── */

    function runAction(action) {
        switch (action) {
            case 'addEndpoint':
                post({ type: 'addEndpoint' });
                break;
            case 'addEndpointFromClipboard':
                post({ type: 'addEndpoint', fromClipboard: true });
                break;
            case 'addEnvironment':
                post({ type: 'addEnvironment' });
                break;
            case 'import':
                window.HubLayout?.switchSection('import');
                break;
            case 'puppySchool':
                post({ type: 'openPuppySchool' });
                break;
            case 'workspaceFolder':
                post({ type: 'selectWorkspaceFolder' });
                break;
            case 'saveCatalogue':
                post({ type: 'saveCatalogueToAccount' });
                break;
            case 'reopenTabs':
                document.getElementById('hubHomeReopen')?.classList.add('hidden');
                post({ type: 'reopenTabs' });
                break;
        }
    }

    function init() {
        const home = document.getElementById('hubHome');
        if (!home) return;

        home.addEventListener('click', (e) => {
            const link = e.target.closest('[data-home-link]');
            if (link) {
                e.preventDefault();
                post({ type: 'openExternalUrl', payload: { url: link.dataset.homeLink } });
                return;
            }
            const section = e.target.closest('[data-home-section]');
            if (section) {
                window.HubLayout?.switchSection(section.dataset.homeSection);
                return;
            }
            const action = e.target.closest('[data-home-action]');
            if (action) runAction(action.dataset.homeAction);
        });

        // A name beside the rail and its rail item are one item: the pointer on either lights both
        const pair = section => [
            document.querySelector('.hub-nav-item[data-section="' + section + '"]'),
            home.querySelector('.hub-home-guide-item[data-home-section="' + section + '"]')
        ];
        const hover = (section, on) => pair(section).forEach(el => el?.classList.toggle('is-hovered', on));
        home.querySelectorAll('.hub-home-guide-item').forEach(name => {
            name.addEventListener('pointerenter', () => hover(name.dataset.homeSection, true));
            name.addEventListener('pointerleave', () => hover(name.dataset.homeSection, false));
        });
        document.querySelectorAll('.hub-nav-item[data-section]').forEach(item => {
            item.addEventListener('pointerenter', () => hover(item.dataset.section, true));
            item.addEventListener('pointerleave', () => hover(item.dataset.section, false));
        });

        document.getElementById('hubHomeTipPrev')?.addEventListener('click', () => stepTip(-1));
        document.getElementById('hubHomeTipNext')?.addEventListener('click', () => stepTip(1));
        tipIndex = dayNumber() % TIPS.length;
        stepTip(0);
        renderPuppySchool(null);

        window.addEventListener('message', (event) => {
            const message = event.data || {};
            if (message.type === 'hubHomeInfo') {
                renderReopen(message.reopen);
                renderWhatsNew(message.whatsNew);
            } else if (message.type === 'hubState') {
                renderWorkspace(message.workspaceInfo);
                renderCatalogueStorage(message.catalogueStorage);
            } else if (message.type === 'badgeStateUpdate') {
                renderPuppySchool(message);
            } else if (message.type === 'authStateUpdate') {
                renderWeek(message);
            }
        });
    }

    window.HubHome = { init, TIPS };
})();

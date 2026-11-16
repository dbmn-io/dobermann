// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Account section embedded inside the DBMN Hub.
// Mirrors src/webviews/account/account.js, adapted to:
//   - share the Hub's vscode API (no acquireVsCodeApi() — that's a once-only call)
//   - send `accountReady` so hub-manager knows when to push initial state
//   - expose init() so hub.js can wire it after DOMContentLoaded
(function() {
    'use strict';

    let initialised = false;
    let activeNotificationTimeout = null;
    // Whether a stats refresh is in flight. Starts true because opening the
    // Account section triggers a refresh, so the usage headers spin from first
    // paint until it settles.
    let statsRefreshing = true;

    function init() {
        if (initialised) { return; }
        initialised = true;

        const vscode = window.vscode;
        if (!vscode) {
            console.error('[HubAccount] window.vscode not present — hub.js must run first');
            return;
        }

        // GitHub Issue #263: signed-out view is a single button. The shared
        // DbmnModal handles email input + submission via sendDbmnSignInLinkInApp.

        // ── Inbound messages from the host ───────────────────────────────
        window.addEventListener('message', function(event) {
            const message = event.data || {};
            switch (message.type) {
                case 'authStateUpdate':
                    renderAuthState(message);
                    break;
                case 'statsRefreshing':
                    statsRefreshing = !!message.refreshing;
                    applyStatsRefreshingUI();
                    break;
                case 'connectivityWarning':
                    showFooterNotification('warning', message.message, { persistent: true });
                    const refreshBtn = document.getElementById('footer-refresh-session-btn');
                    if (refreshBtn) { refreshBtn.classList.remove('hidden'); }
                    break;
                case 'badgeStateUpdate':
                    renderBadgeState(message);
                    break;
                case 'flexionTechStatus':
                    renderFlexionTechSection(message);
                    break;
                case 'flexionTechImportResult':
                    handleFlexionTechResult(message);
                    break;
            }
        });

        // Tell the host this delegate is wired up — host pushes initial auth
        // state in response.
        vscode.postMessage({ type: 'accountReady' });
    }

    /**
     * Badges + Puppy School progress. Display only: every label arrives from the host
     * (badge.service.ts) and the artwork comes from shared/badges.js. A locked badge is a
     * generic outline (Badges.lockedSvg) — its art is not drawn at all until it is earned.
     */
    function renderBadgeState(message) {
        const state = message.state;
        const pill = document.getElementById('puppy-school-progress');
        const button = document.getElementById('puppy-school-btn');
        if (pill) {
            pill.textContent = message.progressLabel || 'Not started';
            pill.className = 'status-pill-generic' + (state && state.puppySchool.graduatedAt ? ' success' : '');
        }
        if (button) { button.textContent = message.actionLabel || 'Start Puppy School'; }

        // The dot on the Account nav icon: something was earned since they last looked here.
        const navButton = document.querySelector('.hub-nav-item[data-section="account"]');
        if (navButton) {
            const unseen = state ? state.unseen.length : 0;
            navButton.classList.toggle('has-unseen-badge', unseen > 0);
            navButton.title = unseen > 0 ? 'DBMN account — new badge earned' : 'DBMN account';
        }

        const grid = document.getElementById('badge-grid');
        if (!grid) { return; }
        grid.textContent = '';
        const badges = state ? state.badges : [];
        badges.forEach(function(badge) {
            const earned = !!badge.earnedAt;
            const item = document.createElement('div');
            item.className = 'dbmn-badge' + (earned ? '' : ' dbmn-badge-locked');
            item.setAttribute('role', 'listitem');
            // The card says the lesson; the trick (the badge's name) is on the picture and in the tip.
            const caption = (message.captions && message.captions[badge.id]) || badge.name;
            item.title = earned
                ? badge.name + ' — earned ' + new Date(badge.earnedAt).toLocaleDateString()
                : badge.name + ' — ' + badge.description;

            const art = document.createElement('div');
            art.className = 'dbmn-badge-art';
            // Trusted, bundled SVG keyed by id — never server-supplied markup.
            art.innerHTML = !window.Badges ? '' : earned ? window.Badges.badgeSvg(badge.id) : window.Badges.lockedSvg(badge.id);

            const name = document.createElement('div');
            name.className = 'dbmn-badge-name';
            name.textContent = caption;

            item.appendChild(art);
            item.appendChild(name);
            grid.appendChild(item);
        });
    }

    function renderAuthState(state) {
        const signedOutView = document.getElementById('signed-out-view');
        const signedInView = document.getElementById('signed-in-view');
        const signOutBtn = document.getElementById('footer-sign-out-btn');
        const refreshSessionBtn = document.getElementById('footer-refresh-session-btn');

        const expiredBanner = document.getElementById('account-expired-banner');
        if (state.isAuthenticated) {
            signedOutView.classList.add('hidden');
            signedInView.classList.remove('hidden');
            signOutBtn.classList.remove('hidden');
            clearFooterNotification();
            renderDashboard(state);
            // Honest expired state: the session exists but its refresh is dead
            // (auth_error). Show an inline banner + the Sign In (refresh) button
            // instead of pretending everything's fine. In-panel, not a toast.
            const expired = state.connectivityStatus === 'auth_error';
            if (expiredBanner) expiredBanner.classList.toggle('hidden', !expired);
            refreshSessionBtn.classList.toggle('hidden', !expired);
        } else {
            signedOutView.classList.remove('hidden');
            signedInView.classList.add('hidden');
            signOutBtn.classList.add('hidden');
            refreshSessionBtn.classList.add('hidden');
            if (expiredBanner) expiredBanner.classList.add('hidden');
        }
    }

    function renderDashboard(state) {
        const nameStat = document.getElementById('account-name-stat');
        const nameEl = document.getElementById('account-name');
        if (state.displayName) {
            nameEl.textContent = state.displayName;
            nameStat.classList.remove('hidden');
        } else {
            nameStat.classList.add('hidden');
        }
        document.getElementById('account-email').textContent = state.email || '';

        const weekLabel = document.getElementById('usage-week-label');
        if (state.usage) {
            weekLabel.textContent = state.usage.weekStart ? 'Week of ' + state.usage.weekStart : '';
        } else {
            weekLabel.textContent = '';
        }

        const weekly = state.telemetryStats ? state.telemetryStats.weekly : null;
        const alltime = state.telemetryStats ? state.telemetryStats.alltime : null;

        const usageStatsGrid = document.getElementById('usage-stats-grid');
        if (weekly) {
            usageStatsGrid.classList.remove('hidden');
            document.getElementById('usage-api-calls').textContent = String(weekly.apiCalls || 0);
            let weeklyBatches = String(weekly.batchRuns);
            document.getElementById('usage-batch-runs').textContent = weeklyBatches;
            document.getElementById('usage-rows-processed').textContent = String(weekly.rowsProcessed);
            document.getElementById('usage-run-time').textContent = formatRunTime(weekly.totalExecutionTimeMs);
        } else {
            usageStatsGrid.classList.add('hidden');
        }

        const totalStatsGrid = document.getElementById('total-stats-grid');
        if (alltime) {
            totalStatsGrid.classList.remove('hidden');
            document.getElementById('total-api-calls').textContent = String(alltime.apiCalls || 0);
            document.getElementById('total-batch-runs').textContent = String(alltime.batchRuns);
            document.getElementById('total-rows-processed').textContent = String(alltime.rowsProcessed);
            document.getElementById('total-run-time').textContent = formatRunTime(alltime.totalExecutionTimeMs);
        } else {
            totalStatsGrid.classList.add('hidden');
        }

        applyStatsRefreshingUI();
    }

    /**
     * Reflect the current refresh state on the usage sections: a spinner next
     * to each header while refreshing, cached/fresh numbers whenever present,
     * and a subtle dash only once a refresh settles with nothing to show
     * (offline, never cached).
     */
    function applyStatsRefreshingUI() {
        updateUsageSectionState('usage-stats-spinner', 'usage-stats-grid', 'usage-stats-loading');
        updateUsageSectionState('total-stats-spinner', 'total-stats-grid', 'total-stats-loading');
    }

    function updateUsageSectionState(spinnerId, gridId, placeholderId) {
        const spinner = document.getElementById(spinnerId);
        const grid = document.getElementById(gridId);
        const placeholder = document.getElementById(placeholderId);
        if (spinner) { spinner.classList.toggle('hidden', !statsRefreshing); }
        if (!grid || !placeholder) { return; }
        const hasData = !grid.classList.contains('hidden');
        // #419: with sharing off there is nothing to show, and the page says why
        const sharingOff = gridId === 'usage-stats-grid' && document.body.classList.contains('telemetry-off');
        if (sharingOff) {
            grid.classList.add('hidden');
            placeholder.textContent = 'Turn on usage sharing to see this.';
            placeholder.classList.remove('hidden');
        } else if (hasData || statsRefreshing) {
            placeholder.classList.add('hidden');
        } else {
            placeholder.textContent = '—';
            placeholder.classList.remove('hidden');
        }
    }

    function formatRunTime(ms) {
        if (!ms || ms <= 0) { return '0s'; }
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) { return days + 'd ' + (hours % 24) + 'h'; }
        if (hours > 0) { return hours + 'h ' + (minutes % 60) + 'm'; }
        if (minutes > 0) { return minutes + 'm ' + (seconds % 60) + 's'; }
        return seconds + 's';
    }

    // Delegates to the shared fixed-overlay DbmnToast (loaded by the Hub).
    function showFooterNotification(type, message, options) {
        options = options || {};
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message, {
                durationMs: options.duration,
                persistent: options.persistent,
                shake: options.shake,
                dismissible: options.dismissible
            });
        }
    }

    function clearFooterNotification() {
        const el = document.getElementById('footerNotification');
        if (el) { el.classList.add('hidden'); }
        if (activeNotificationTimeout) {
            clearTimeout(activeNotificationTimeout);
            activeNotificationTimeout = null;
        }
    }
    // Inline onclick handlers still need this on window.
    window.clearFooterNotification = clearFooterNotification;

    function renderFlexionTechSection(status) {
        const section = document.getElementById('flexiontech-migration-section');
        const autoDiv = document.getElementById('flexiontech-auto');
        const manualDiv = document.getElementById('flexiontech-manual');

        if (!status.installed) {
            section.classList.add('hidden');
            return;
        }
        section.classList.remove('hidden');

        if (status.hasApi) {
            autoDiv.classList.remove('hidden');
            manualDiv.classList.add('hidden');
        } else {
            autoDiv.classList.add('hidden');
            manualDiv.classList.remove('hidden');
            const versionLabel = document.getElementById('flexiontech-version-label');
            if (versionLabel) { versionLabel.textContent = 'v' + status.version; }
        }
    }

    function handleFlexionTechResult(message) {
        const btnText = document.getElementById('migration-btn-text');
        const spinner = document.getElementById('migration-btn-spinner');
        const importBtn = document.getElementById('migration-import-btn');
        const buttons = document.getElementById('migration-buttons');
        const resultEl = document.getElementById('migration-result');

        spinner.classList.add('hidden');
        importBtn.disabled = false;
        btnText.textContent = 'Import Environments & Endpoints';

        if (message.success) {
            const skipped = message.endpointsSkipped + message.environmentsSkipped;
            let text = 'Imported ' + message.endpointsImported + ' endpoints and ' +
                message.environmentsImported + ' environments.';
            if (skipped > 0) { text += ' (' + skipped + ' duplicates skipped)'; }

            resultEl.textContent = text;
            resultEl.className = 'footer-notification notification-info';
            resultEl.classList.remove('hidden');
            buttons.classList.add('hidden');

            const postImport = document.getElementById('migration-post-import');
            if (postImport) { postImport.classList.remove('hidden'); }

            showFooterNotification('info', 'Migration complete!');
        } else {
            resultEl.textContent = message.error;
            resultEl.className = 'footer-notification notification-error';
            resultEl.classList.remove('hidden');
        }
    }

    // Global handlers — the markup's data-click actions (registered below; #372: no inline handlers).
    // GitHub Issue #263: opens the shared DbmnModal sign-in flow on the host.
    window.handleSignIn = function() { window.vscode.postMessage({ type: 'signIn' }); };
    window.handleSignOut = function() { window.vscode.postMessage({ type: 'signOut' }); };
    window.handleOpenPuppySchool = function() { window.vscode.postMessage({ type: 'openPuppySchool' }); };
    window.handleRefreshSession = function() { window.vscode.postMessage({ type: 'refreshSession' }); };

    window.handleFlexionTechImport = function() {
        const btn = document.getElementById('migration-import-btn');
        const btnText = document.getElementById('migration-btn-text');
        const spinner = document.getElementById('migration-btn-spinner');
        const resultEl = document.getElementById('migration-result');

        btn.disabled = true;
        btnText.textContent = 'Importing...';
        spinner.classList.remove('hidden');
        resultEl.classList.add('hidden');

        window.vscode.postMessage({ type: 'importFromFlexionTech' });
    };

    window.handleDismissFlexionTech = function() {
        window.vscode.postMessage({ type: 'dismissFlexionTechMigration' });
        document.getElementById('flexiontech-migration-section').classList.add('hidden');
    };

    // In the Hub-embedded version, "Open Import / Export" routes the user to
    // the Hub's own Import section rather than launching a separate webview.
    window.handleOpenImportExport = function() {
        const importBtn = document.querySelector('.hub-nav-item[data-section="import"]');
        if (importBtn) {
            importBtn.click();
        } else {
            window.vscode.postMessage({ type: 'openImportExport' });
        }
    };

    // #372: what the Hub's markup may call (data-click). Each resolves the global at click time,
    // as the inline handlers did (clearFooterNotification is import-export's or this file's).
    window.DbmnActions?.register({
        handleSignIn: () => window.handleSignIn(),
        handleSignOut: () => window.handleSignOut(),
        handleOpenPuppySchool: () => window.handleOpenPuppySchool(),
        handleRefreshSession: () => window.handleRefreshSession(),
        handleFlexionTechImport: () => window.handleFlexionTechImport(),
        handleDismissFlexionTech: () => window.handleDismissFlexionTech(),
        handleOpenImportExport: () => window.handleOpenImportExport(),
        clearFooterNotification: () => window.clearFooterNotification()
    });

    // #419: the Hub tells the page when the telemetry switch changes, so Weekly Usage says why it is empty
    window.HubAccount = { init: init, refreshUsageState: () => applyStatsRefreshingUI() };

    // Self-init guarantee. hub.js orchestrates embedded modules by calling
    // `window.HubAccount.init()` from its own init() — but hub.js is a deferred
    // script that executes BEFORE this one (hub.js precedes account-frontend.js
    // in hub.html, and deferred scripts run in document order with the document
    // already parsed, so hub.js's init() runs synchronously). At that moment
    // `window.HubAccount` is still undefined, so hub.js silently skips it and the
    // `accountReady` handshake never fires — the backend account delegate then
    // never subscribes to auth state and the panel never reflects sign-in.
    // Self-initialising here closes that gap; the `initialised` guard makes
    // hub.js's later (no-op) call safe.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

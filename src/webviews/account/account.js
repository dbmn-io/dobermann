// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Account webview JavaScript (GitHub Issue #211)
(function() {
    const vscode = acquireVsCodeApi();

    // Whether a stats refresh is currently in flight. Starts true because a
    // refresh always follows the initial state push (standalone open / section
    // shown), so the usage headers spin from first paint until it settles.
    var statsRefreshing = true;

    window.addEventListener('load', () => {
        vscode.postMessage({ type: 'ready' });
        // GitHub Issue #263: signed-out view is a single button. The shared
        // DbmnModal handles email input + submission via sendDbmnSignInLinkInApp.
    });

    // Listen for messages from extension
    window.addEventListener('message', function(event) {
        var message = event.data;

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
                var refreshBtn = document.getElementById('footer-refresh-session-btn');
                if (refreshBtn) { refreshBtn.classList.remove('hidden'); }
                break;
            case 'flexionTechStatus':
                renderFlexionTechSection(message);
                break;
            case 'flexionTechImportResult':
                handleFlexionTechResult(message);
                break;
            case 'checkUnsavedChanges':
                vscode.postMessage({
                    type: 'unsavedChangesResponse',
                    hasUnsavedChanges: false
                });
                break;
        }
    });

    function renderAuthState(state) {
        var signedOutView = document.getElementById('signed-out-view');
        var signedInView = document.getElementById('signed-in-view');
        var signOutBtn = document.getElementById('footer-sign-out-btn');
        var refreshSessionBtn = document.getElementById('footer-refresh-session-btn');

        var expiredBanner = document.getElementById('account-expired-banner');
        if (state.isAuthenticated) {
            signedOutView.classList.add('hidden');
            signedInView.classList.remove('hidden');
            signOutBtn.classList.remove('hidden');
            clearFooterNotification();
            renderDashboard(state);
            // Honest expired state: session present but refresh dead (auth_error).
            // Show inline banner + Sign In (refresh) button instead of "signed in".
            var expired = state.connectivityStatus === 'auth_error';
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
        // Account name + email
        var nameStat = document.getElementById('account-name-stat');
        var nameEl = document.getElementById('account-name');
        if (state.displayName) {
            nameEl.textContent = state.displayName;
            nameStat.classList.remove('hidden');
        } else {
            nameStat.classList.add('hidden');
        }
        document.getElementById('account-email').textContent = state.email || '';

        // Week label
        var weekLabel = document.getElementById('usage-week-label');
        if (state.usage) {
            weekLabel.textContent = state.usage.weekStart ? 'Week of ' + state.usage.weekStart : '';
        } else {
            weekLabel.textContent = '';
        }

        // Telemetry stats (weekly + total). Show cached/fresh numbers whenever
        // present; the spinner + dash states are driven by applyStatsRefreshingUI.
        var weekly = state.telemetryStats ? state.telemetryStats.weekly : null;
        var alltime = state.telemetryStats ? state.telemetryStats.alltime : null;

        var usageStatsGrid = document.getElementById('usage-stats-grid');
        if (weekly) {
            usageStatsGrid.classList.remove('hidden');
            document.getElementById('usage-api-calls').textContent = String(weekly.apiCalls || 0);
            // #418: no weekly batch limit; the count is the count
            var weeklyBatches = String(weekly.batchRuns);
            document.getElementById('usage-batch-runs').textContent = weeklyBatches;
            document.getElementById('usage-rows-processed').textContent = String(weekly.rowsProcessed);
            document.getElementById('usage-run-time').textContent = formatRunTime(weekly.totalExecutionTimeMs);
        } else {
            usageStatsGrid.classList.add('hidden');
        }

        var totalStatsGrid = document.getElementById('total-stats-grid');
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
     * Reflect the current refresh state on the two usage sections:
     *   - spinner next to the header while a refresh is in flight;
     *   - when a section has no numbers, show a spinner-only body while
     *     refreshing, or a subtle dash once settled (offline, never cached).
     * Cached/fresh numbers (the grid) are managed by renderAuthState and left
     * untouched here.
     */
    function applyStatsRefreshingUI() {
        updateUsageSectionState('usage-stats-spinner', 'usage-stats-grid', 'usage-stats-loading');
        updateUsageSectionState('total-stats-spinner', 'total-stats-grid', 'total-stats-loading');
    }

    function updateUsageSectionState(spinnerId, gridId, placeholderId) {
        var spinner = document.getElementById(spinnerId);
        var grid = document.getElementById(gridId);
        var placeholder = document.getElementById(placeholderId);
        if (spinner) { spinner.classList.toggle('hidden', !statsRefreshing); }
        if (!grid || !placeholder) { return; }
        var hasData = !grid.classList.contains('hidden');
        if (hasData || statsRefreshing) {
            // Numbers shown, or the header spinner already signals loading.
            placeholder.classList.add('hidden');
        } else {
            // Settled with nothing to show (offline, never cached) — dash.
            placeholder.textContent = '—';
            placeholder.classList.remove('hidden');
        }
    }

    function formatRunTime(ms) {
        if (!ms || ms <= 0) { return '0s'; }
        var seconds = Math.floor(ms / 1000);
        var minutes = Math.floor(seconds / 60);
        var hours = Math.floor(minutes / 60);
        var days = Math.floor(hours / 24);

        if (days > 0) { return days + 'd ' + (hours % 24) + 'h'; }
        if (hours > 0) { return hours + 'h ' + (minutes % 60) + 'm'; }
        if (minutes > 0) { return minutes + 'm ' + (seconds % 60) + 's'; }
        return seconds + 's';
    }

    // Footer notification helpers
    var activeNotificationTimeout = null;

    // Delegates to the shared fixed-overlay DbmnToast (no content shift).
    function showFooterNotification(type, message, options) {
        options = options || {};
        if (window.DbmnToast) {
            window.DbmnToast.show(type, message, {
                durationMs: options.duration,
                persistent: options.persistent,
                shake: options.shake,
                dismissible: options.dismissible
            });
            return;
        }
        vscode.postMessage({ type: type === 'error' ? 'showError' : type === 'warning' ? 'showWarning' : 'showInfo', message: message });
    }

    window.clearFooterNotification = function() {
        var el = document.getElementById('footerNotification');
        if (el) {
            el.classList.add('hidden');
        }
        if (activeNotificationTimeout) {
            clearTimeout(activeNotificationTimeout);
            activeNotificationTimeout = null;
        }
    };

    // FlexionTech migration UI
    function renderFlexionTechSection(status) {
        var section = document.getElementById('flexiontech-migration-section');
        var autoDiv = document.getElementById('flexiontech-auto');
        var manualDiv = document.getElementById('flexiontech-manual');

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
            var versionLabel = document.getElementById('flexiontech-version-label');
            if (versionLabel) {
                versionLabel.textContent = 'v' + status.version;
            }
        }
    }

    function handleFlexionTechResult(message) {
        var btnText = document.getElementById('migration-btn-text');
        var spinner = document.getElementById('migration-btn-spinner');
        var importBtn = document.getElementById('migration-import-btn');
        var buttons = document.getElementById('migration-buttons');
        var resultEl = document.getElementById('migration-result');

        spinner.classList.add('hidden');
        importBtn.disabled = false;
        btnText.textContent = 'Import Environments & Endpoints';

        if (message.success) {
            var total = message.endpointsImported + message.environmentsImported;
            var skipped = message.endpointsSkipped + message.environmentsSkipped;
            var text = 'Imported ' + message.endpointsImported + ' endpoints and ' +
                message.environmentsImported + ' environments.';
            if (skipped > 0) {
                text += ' (' + skipped + ' duplicates skipped)';
            }

            resultEl.textContent = text;
            resultEl.className = 'footer-notification notification-info';
            resultEl.classList.remove('hidden');
            buttons.classList.add('hidden');

            var postImport = document.getElementById('migration-post-import');
            if (postImport) { postImport.classList.remove('hidden'); }

            showFooterNotification('info', 'Migration complete!');
        } else {
            resultEl.textContent = message.error;
            resultEl.className = 'footer-notification notification-error';
            resultEl.classList.remove('hidden');
        }
    }

    // Global handlers called from HTML onclick attributes

    // GitHub Issue #263: opens the shared DbmnModal sign-in flow on the host
    // (Account panel or Hub). The extension host pre-fills the email and posts
    // the magic link via sendDbmnSignInLinkInApp.
    window.handleSignIn = function() {
        vscode.postMessage({ type: 'signIn' });
    };

    window.handleSignOut = function() {
        vscode.postMessage({ type: 'signOut' });
    };

    window.handleRefreshSession = function() {
        vscode.postMessage({ type: 'refreshSession' });
    };

    window.handleFlexionTechImport = function() {
        var btn = document.getElementById('migration-import-btn');
        var btnText = document.getElementById('migration-btn-text');
        var spinner = document.getElementById('migration-btn-spinner');
        var resultEl = document.getElementById('migration-result');

        btn.disabled = true;
        btnText.textContent = 'Importing...';
        spinner.classList.remove('hidden');
        resultEl.classList.add('hidden');

        vscode.postMessage({ type: 'importFromFlexionTech' });
    };

    window.handleDismissFlexionTech = function() {
        vscode.postMessage({ type: 'dismissFlexionTechMigration' });
        document.getElementById('flexiontech-migration-section').classList.add('hidden');
    };

    window.handleOpenImportExport = function() {
        vscode.postMessage({ type: 'openImportExport' });
    };
})();

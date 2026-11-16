// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #197 / #229: Console Settings Module
 *
 * Handles settings persistence using the Views system (column visibility,
 * column order, root paths, sort state) for the console webview.
 * Discards legacy settings formats — few users, not worth migration complexity.
 *
 * Architecture Compliance:
 * - Extracted from inline JavaScript in console.html
 * - Uses window.dynamicReportManager for data access
 * - Uses window.vscode for postMessage
 */

class ConsoleSettings {
    constructor(vscode) {
        this.vscode = vscode;
        this.currentEndpointId = null;
        this.saveTimeout = null;
    }

    /**
     * Detect whether settings are in the new Views format.
     * GitHub Issue #229 Phase 1A: only accept views with `rowBasis`. Any
     * saved file with the legacy `rootPath` field is treated as stale and
     * discarded so the frontend auto-seeds a fresh Root view.
     */
    isViewsFormat(settings) {
        if (!settings || !settings.success ||
            typeof settings.success.activeView !== 'string' ||
            !Array.isArray(settings.success.views)) {
            return false;
        }
        // Require at least one view with the new-model rowBasis field, OR an
        // empty views array (brand-new endpoint). Legacy files use rootPath.
        const successViews = settings.success.views;
        if (successViews.length === 0) return true;
        return successViews.some(v => v && typeof v.rowBasis === 'string');
    }

    applyConsoleSettings(settings, endpointId) {
        this.currentEndpointId = endpointId;

        if (!this.isViewsFormat(settings)) {
            // Old/unrecognized format — discard and start fresh
            console.warn('[ConsoleSettings] Discarding legacy settings format, starting fresh');
            return;
        }

        // GitHub Issue #229 Phase 1A: Just write the valid views into
        // userSettings. Do NOT trigger any re-render here — the render flow is
        // owned by switchTab/getActiveView, and having applyConsoleSettings
        // double-render caused stale state from before auto-seeding to fight
        // with the freshly-seeded view (producing empty cols=0 tables).
        if (!window.dynamicReportManager || !window.dynamicReportManager.userSettings) {
            return;
        }
        ['success', 'errors'].forEach(tab => {
            if (!settings[tab] || !Array.isArray(settings[tab].views)) {
                window.dynamicReportManager.userSettings[tab] = { activeView: '', views: [] };
                return;
            }
            const validViews = settings[tab].views.filter(v => v && typeof v.rowBasis === 'string');
            if (validViews.length === 0) {
                window.dynamicReportManager.userSettings[tab] = { activeView: '', views: [] };
                return;
            }
            const activeView = settings[tab].activeView && validViews.some(v => v.name === settings[tab].activeView)
                ? settings[tab].activeView
                : validViews[0].name;
            window.dynamicReportManager.userSettings[tab] = { activeView, views: validViews };
        });

        // If settings land after the first render, re-render the current tab
        // once so the saved view (if any) takes effect. No path correction, no
        // mutation of view state — just let extractAndRender do its job.
        const currentTab = window.dynamicReportManager.currentTab;
        if (currentTab === 'success' || currentTab === 'errors') {
            window.dynamicReportManager.extractAndRender(currentTab);
        }
    }

    saveConsoleSettings() {
        if (!this.currentEndpointId) {
            return;
        }

        let settingsToSave = null;

        if (window.dynamicReportManager && window.dynamicReportManager.userSettings) {
            const settings = window.dynamicReportManager.userSettings;

            // Issue #229: rowBasis is any absolute JSON path or "root" —
            // validating against a discovered-paths list is a leftover from
            // the pre-views model and corrupted user selections (e.g. reset
            // "data.data" to "root" on every save). Removed.
            settingsToSave = {};
            ['success', 'errors'].forEach(tab => {
                const tabSettings = settings[tab];
                if (tabSettings && Array.isArray(tabSettings.views)) {
                    settingsToSave[tab] = {
                        activeView: tabSettings.activeView || '',
                        defaultView: tabSettings.defaultView,
                        views: tabSettings.views
                    };
                } else {
                    settingsToSave[tab] = { activeView: '', views: [] };
                }
            });
        }

        if (settingsToSave) {
            this.vscode.postMessage({
                type: 'console.save_settings',
                correlationId: `save_settings_${Date.now()}`,
                timestamp: Date.now(),
                payload: {
                    endpointId: this.currentEndpointId,
                    settings: settingsToSave
                }
            });
        }
    }

    /**
     * Debounced save function to avoid too many saves
     */
    debouncedSaveSettings() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => this.saveConsoleSettings(), 500);
    }
}

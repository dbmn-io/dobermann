// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Hub Preferences Service
 *
 * The Hub webview keeps its UI preferences (catalogue Show / Group by /
 * Recent, transaction filters, column width, collapsed groups…) in
 * `vscode.getState()/setState()`. That store lives and dies with the webview
 * panel — and on activation the extension disposes any restored Hub and
 * creates a fresh one (see `registerWebviewPanelSerializer('hub')` in
 * extension.ts), so every session started empty and "Group by: URL"
 * silently reverted.
 *
 * This service mirrors that state object into `context.globalState` (user
 * preference, shared across workspaces — Architecture.md → State
 * Boundaries). The webview posts the full object on every change and the
 * host seeds it back on first paint. It is a plain JSON object of small
 * scalars/arrays; the size guard keeps a bug from bloating globalState.
 */

export interface HubPreferencesStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

export type HubPreferences = Record<string, unknown>;

export const HUB_PREFERENCES_STORAGE_KEY = 'dbmn_hub_preferences';
/** Anything bigger than this is not a preferences object; drop it. */
export const HUB_PREFERENCES_MAX_JSON_BYTES = 64 * 1024;

export class HubPreferencesService {
    constructor(private readonly store: HubPreferencesStore) {}

    get(): HubPreferences {
        const raw = this.store.get<unknown>(HUB_PREFERENCES_STORAGE_KEY);
        return isPlainObject(raw) ? { ...raw } : {};
    }

    /** Replace the stored object. Returns false (and stores nothing) when rejected. */
    async set(prefs: unknown): Promise<boolean> {
        if (!isPlainObject(prefs)) return false;
        let json: string;
        try {
            json = JSON.stringify(prefs);
        } catch {
            return false;
        }
        if (json.length > HUB_PREFERENCES_MAX_JSON_BYTES) return false;
        // Round-trip through JSON so functions / undefined / class instances
        // never reach globalState.
        await this.store.update(HUB_PREFERENCES_STORAGE_KEY, JSON.parse(json));
        return true;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

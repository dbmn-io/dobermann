// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #281: the user's DBMN settings follow them. Signed in, the settings in ACCOUNT_SETTINGS are
 * read from and written to the account (Supabase `user_settings`), in VS Code and the web app
 * alike; every other setting, and all of them signed out, stay with the host (VS Code's
 * settings, the browser's state).
 *
 * - One instance per host, handed to every screen as its settings (HubSettings): screens never
 *   know where a setting lives.
 * - A setting the account doesn't have yet falls back to the host's value, then the default.
 * - Signing in for the first time on a device brings that device's own values for settings the
 *   account has no value for (once per device and account: `adopt`).
 * - Changes made on another device arrive by Realtime.
 * - Settings that only mean something on one host (VS Code's Hub preload, its vscode:// OAuth
 *   redirect) never roam.
 */
import type { IWritableConfiguration } from '../../platform/interfaces/configuration.interface';

/** The settings that follow the user, by full name (`section.key`). */
export const ACCOUNT_SETTINGS: ReadonlySet<string> = new Set([
    'dbmn.ui.confirmTransactionDeletion',
    'dbmn.execution.criticalErrorCodes',
    'dbmn.execution.treatNetworkErrorsAsCritical',
    'dbmn.execution.autoOpenConsoleOnCompletion',
    'dbmn.execution.maxCsvRows'
]);

export type SettingsMap = Record<string, unknown>;

/** Where the account's settings are kept (SupabaseSettingsStore; memory in tests). */
export interface AccountSettingsStore {
    load(): Promise<SettingsMap>;
    /** Set one setting (undefined removes it); every setting after the change. */
    set(name: string, value: unknown): Promise<SettingsMap>;
    /** Changes made elsewhere: the whole map after each. Resolves once listening. */
    follow(onChanged: (settings: SettingsMap) => void): Promise<void>;
    dispose(): Promise<void>;
}

const fullName = (section: string, key: string) => `${section}.${key}`;

export class AccountSettings implements IWritableConfiguration {
    private store?: AccountSettingsStore;
    private values: SettingsMap = {};
    private readonly listeners = new Set<() => void>();

    /** `host`: this host's own settings (VS Code's; the browser's), used for everything else. */
    constructor(private readonly host: IWritableConfiguration) {}

    get<T>(section: string, key: string, defaultValue: T): T {
        const name = fullName(section, key);
        if (this.store && ACCOUNT_SETTINGS.has(name) && name in this.values) {
            return this.values[name] as T;
        }
        return this.host.get(section, key, defaultValue);
    }

    async update(section: string, key: string, value: unknown): Promise<void> {
        const name = fullName(section, key);
        if (this.store && ACCOUNT_SETTINGS.has(name)) {
            this.values = await this.store.set(name, value);
            this.notify();
            return;
        }
        await this.host.update(section, key, value);
    }

    /** Signed in: the account's settings from now on. Any failure leaves the host's in use. */
    async connect(store: AccountSettingsStore, log: (message: string, error?: unknown) => void): Promise<void> {
        await this.disconnect();
        const values = await store.load();
        this.store = store;
        this.values = values;
        this.notify();
        store.follow(settings => {
            if (this.store !== store) return;
            this.values = settings;
            this.notify();
        }).catch(error => log('[Settings] Realtime unavailable: settings changed elsewhere show after the next sign-in', error));
    }

    /**
     * Once per device and account: this device's own values (explicitly set, not defaults) for
     * settings the account has no value for. How many came in.
     */
    async adopt(own: SettingsMap): Promise<number> {
        if (!this.store) return 0;
        let added = 0;
        for (const [name, value] of Object.entries(own)) {
            if (!ACCOUNT_SETTINGS.has(name) || value === undefined || name in this.values) continue;
            this.values = await this.store.set(name, value);
            added++;
        }
        if (added) this.notify();
        return added;
    }

    /** Signed out: the host's settings again. */
    async disconnect(): Promise<void> {
        const store = this.store;
        this.store = undefined;
        this.values = {};
        if (store) {
            this.notify();
            await store.dispose().catch(() => undefined);
        }
    }

    get connected(): boolean {
        return this.store !== undefined;
    }

    /** Settings changed (a write here, a change elsewhere, sign-in or out): screens re-read. */
    onDidChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try { listener(); } catch { /* a screen's problem, not the setting's */ }
        }
    }
}

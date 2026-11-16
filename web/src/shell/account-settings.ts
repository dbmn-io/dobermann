// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #281: the web app's settings: the account's for the settings that follow the user (the same
 * ones VS Code reads), this browser's for the rest (browserSettings). The browser's own values
 * for roaming settings go to the account once, as VS Code's do.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StoreContext } from '../../../src/platform/interfaces/store-context.interface';
import { ACCOUNT_SETTINGS, AccountSettings, type SettingsMap } from '../../../src/services/settings/account-settings';
import { SupabaseSettingsStore } from '../../../src/platform/supabase/supabase-settings-store';
import { browserSettings } from './browser-host';

const ADOPTED_KEY = 'settingsAdoptedAt';

export async function accountSettings(client: SupabaseClient, state: StoreContext): Promise<AccountSettings> {
    const own = browserSettings(state);
    const settings = new AccountSettings(own);
    const log = (message: string, error?: unknown) => console.warn(message, error ?? '');
    try {
        await settings.connect(new SupabaseSettingsStore(client, {
            accessToken: async () => (await client.auth.getSession()).data.session?.access_token
        }), log);
        if (!state.globalState.get<string>(ADOPTED_KEY)) {
            const values: SettingsMap = {};
            for (const name of ACCOUNT_SETTINGS) {
                const dot = name.indexOf('.');
                const value = own.get<unknown>(name.slice(0, dot), name.slice(dot + 1), undefined);
                if (value !== undefined) values[name] = value;
            }
            await settings.adopt(values);
            await state.globalState.update(ADOPTED_KEY, new Date().toISOString());
        }
    } catch (error) {
        log("[Settings] could not use the account's settings; this browser's stay in use", error);
        await settings.disconnect();
    }
    return settings;
}

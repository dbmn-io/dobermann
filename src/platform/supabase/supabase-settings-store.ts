// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #281: the account's settings in Supabase (`user_settings`, one row per user). Writes go one
 * setting at a time through `user_settings_set`, so two devices changing different settings
 * never lose each other's. Like SupabaseCatalogStore, it takes the client the host built and
 * stays environment-blind; Realtime gets the user's token explicitly (otherwise it joins as
 * anon and Row Level Security hides every change).
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { settled } from './settled';
import { subscribeAndListen } from './realtime-ready';
import type { AccountSettingsStore, SettingsMap } from '../../services/settings/account-settings';

const asMap = (value: unknown): SettingsMap =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as SettingsMap : {};

export class SupabaseSettingsStore implements AccountSettingsStore {
    private channel?: RealtimeChannel;
    private authTimer?: ReturnType<typeof setInterval>;

    constructor(
        private readonly client: SupabaseClient,
        private readonly options: { accessToken?: () => Promise<string | null | undefined> } = {}
    ) {}

    async load(): Promise<SettingsMap> {
        const { data, error } = await settled(() => this.client.from('user_settings').select('settings').maybeSingle());
        if (error) throw new Error(`Settings load failed: ${error.message}`);
        return asMap((data as { settings?: unknown } | null)?.settings);
    }

    async set(name: string, value: unknown): Promise<SettingsMap> {
        const { data, error } = await settled(() => this.client.rpc('user_settings_set', { p_key: name, p_value: value ?? null }));
        if (error) throw new Error(`Saving the setting ${name} failed: ${error.message}`);
        return asMap(data);
    }

    async follow(onChanged: (settings: SettingsMap) => void): Promise<void> {
        if (this.channel) return;
        await this.sendRealtimeAuth();
        this.authTimer = setInterval(() => { void this.sendRealtimeAuth(); }, 4 * 60 * 1000);
        const channel = this.client.channel(`settings-${Math.random().toString(36).slice(2)}`);
        channel.on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings' }, payload => {
            const row = payload.new as { settings?: unknown } | undefined;
            if (row && 'settings' in row) onChanged(asMap(row.settings));
        });
        this.channel = channel;
        await subscribeAndListen(channel, 'Settings');
    }

    private async sendRealtimeAuth(): Promise<void> {
        const token = await this.options.accessToken?.();
        if (token) await this.client.realtime.setAuth(token);
    }

    async dispose(): Promise<void> {
        if (this.authTimer) {
            clearInterval(this.authTimer);
            this.authTimer = undefined;
        }
        if (this.channel) {
            await this.client.removeChannel(this.channel);
            this.channel = undefined;
        }
    }
}

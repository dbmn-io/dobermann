// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Subscribe a Realtime channel and resolve once changes actually flow. SUBSCRIBED comes first;
 * Realtime's own "Subscribed to PostgreSQL" (system, postgres_changes, ok) follows a moment later,
 * and a write in between is never heard (seen 2026-10-10 on the test stack). Falls back to
 * SUBSCRIBED + 5 s if that message never comes.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';

export function subscribeAndListen(channel: RealtimeChannel, name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let fallback: ReturnType<typeof setTimeout> | undefined;
        channel.on('system', {}, (message: { extension?: string; status?: string }) => {
            if (message.extension === 'postgres_changes' && message.status === 'ok') {
                clearTimeout(fallback);
                resolve();
            }
        });
        channel.subscribe((status, error) => {
            if (status === 'SUBSCRIBED') fallback = setTimeout(resolve, 5000);
            else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(error ?? new Error(`${name} Realtime: ${status}`));
        });
    });
}

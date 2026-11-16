// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #374: where the user's DBMN for VS Code is listening (`user_agents`, own rows only). VS Code
 * records each window's listener (its id, port, version and the device) under the signed-in
 * user; the web app, signed in as the same user, reads them to know which port to call.
 *
 * A port and some ids: no secret, no run data. The port is random per window and published
 * only here, so only this account's web app learns it; what a caller may do there is still
 * decided by the signature on each message (agent-signature.ts), never by knowing the port.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { settled } from './settled';
import type { AgentListener } from '../../services/agent/agent-listener';

export type { AgentListener };

export async function announceAgentListener(client: SupabaseClient, listener: Omit<AgentListener, 'updatedAt'>): Promise<void> {
    const { error } = await settled(() => client.from('user_agents').upsert({
        listener_id: listener.listenerId,
        device_id: listener.deviceId,
        port: listener.port,
        agent_version: listener.agentVersion,
        updated_at: new Date().toISOString()
    }, { onConflict: 'owner_user_id,listener_id' }));
    if (error) throw new Error(`Could not tell your DBMN account where DBMN for VS Code is listening: ${error.message}`);
}

export async function withdrawAgentListener(client: SupabaseClient, listenerId: string): Promise<void> {
    const { error } = await settled(() => client.from('user_agents').delete().eq('listener_id', listenerId));
    if (error) throw new Error(`Could not remove this DBMN for VS Code from your DBMN account: ${error.message}`);
}

/** Most recently announced first. */
export async function accountAgentListeners(client: SupabaseClient): Promise<AgentListener[]> {
    const { data, error } = await settled(() => client.from('user_agents')
        .select('listener_id, device_id, port, agent_version, updated_at')
        .order('updated_at', { ascending: false }));
    if (error) throw new Error(`Could not read where DBMN for VS Code is listening: ${error.message}`);
    return ((data ?? []) as Array<{ listener_id: string; device_id: string; port: number; agent_version: string; updated_at: string }>).map(row => ({
        listenerId: row.listener_id, deviceId: row.device_id, port: row.port, agentVersion: row.agent_version, updatedAt: row.updated_at
    }));
}

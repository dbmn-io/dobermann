// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The public keys of a DBMN account's web apps (`agent_keys`, own rows only), so DBMN for VS
 * Code, signed in to the same account, can check who signed a message (agent-signature.ts).
 * Public keys only: nothing here can sign anything.
 *
 * - The web app registers its browser's key when it starts (and again when VS Code says it
 *   doesn't know it), and forgets it on Sign Out.
 * - VS Code reads a key by its id. Only its own account's rows are visible to it, so a key it
 *   finds is one this user's signed-in web app put there.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { settled } from './settled';
import { agentKeyId } from '../../services/agent/agent-signature';

/** A browser that hasn't started the web app for this long is forgotten when another registers. */
const KEEP_MS = 90 * 24 * 60 * 60_000;

export async function registerAgentKey(client: SupabaseClient, key: { keyId: string; publicKey: string; label?: string }): Promise<void> {
    const { error } = await settled(() => client.from('agent_keys').upsert({
        key_id: key.keyId,
        public_key: key.publicKey,
        label: (key.label ?? '').slice(0, 200),
        updated_at: new Date().toISOString()
    }, { onConflict: 'owner_user_id,key_id' }));
    if (error) throw new Error(`Could not register this browser with your DBMN account: ${error.message}`);
    // Browsers long gone: best effort, never in the way
    await settled(() => client.from('agent_keys').delete().lt('updated_at', new Date(Date.now() - KEEP_MS).toISOString())).catch(() => undefined);
}

export async function forgetAgentKey(client: SupabaseClient, keyId: string): Promise<void> {
    const { error } = await settled(() => client.from('agent_keys').delete().eq('key_id', keyId));
    if (error) throw new Error(`Could not remove this browser from your DBMN account: ${error.message}`);
}

/**
 * VS Code's lookup: the public key named `keyId` on the signed-in account, or undefined. A key
 * found is remembered for that account (keys don't change); one not found is asked for again
 * next time, so a browser that has just registered is known at once.
 */
export function accountAgentKeys(client: SupabaseClient, userId: () => string | undefined): (keyId: string) => Promise<string | undefined> {
    const known = new Map<string, string>();
    return async keyId => {
        const user = userId();
        if (!user) return undefined;
        const cached = known.get(`${user}:${keyId}`);
        if (cached) return cached;
        const { data, error } = await settled(() => client.from('agent_keys').select('public_key').eq('owner_user_id', user).eq('key_id', keyId).maybeSingle());
        if (error) throw new Error(`could not read your DBMN account's keys (${error.message})`);
        const publicKey = (data as { public_key?: string } | null)?.public_key;
        // The id is the key's own hash: a row that names another key's id is not that key
        if (!publicKey || await agentKeyId(publicKey).catch(() => undefined) !== keyId) return undefined;
        known.set(`${user}:${keyId}`, publicKey);
        return publicKey;
    };
}

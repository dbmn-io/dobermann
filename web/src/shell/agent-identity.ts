// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * This browser's key for DBMN for VS Code (agent-signature.ts): the web app signs every message
 * it sends VS Code with it, and VS Code acts only on what a key of its own DBMN account signed.
 *
 * Made once per account in this browser, by Web Crypto as non-extractable (nothing, our own code
 * included, can read the private key out), and kept in IndexedDB like the vault's key. Its public
 * half goes on the account when the web app starts, and comes off on Sign Out. Where IndexedDB is
 * unavailable the key lasts as long as the tab.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { forgetAgentKey, registerAgentKey } from '../../../src/platform/supabase/agent-keys';
import { agentSigner, newAgentKeyPair, type AgentKeyPair, type AgentSigner } from '../../../src/services/agent/agent-signature';

const DATABASE = 'dbmn-agent';
const KEYS = 'keys';

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function openDatabase(): Promise<IDBDatabase> {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(KEYS); };
    return done(request);
}

const keys = (db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore => db.transaction(KEYS, mode).objectStore(KEYS);

/** This scope's key pair: made once. Two tabs making it at once agree on the first. */
async function scopePair(scope: string): Promise<AgentKeyPair> {
    const db = await openDatabase();
    const existing = await done(keys(db, 'readonly').get(scope)) as AgentKeyPair | undefined;
    if (existing) return existing;
    const made = await newAgentKeyPair();
    try {
        await done(keys(db, 'readwrite').add(made, scope));
        return made;
    } catch {
        return await done(keys(db, 'readonly').get(scope)) as AgentKeyPair;   // another tab's came first
    }
}

/** The browser, as a later "your browsers" list would name it. */
function browserLabel(): string {
    const agent = navigator.userAgent;
    const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
    const system = /Windows/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
    return system ? `${browser} on ${system}` : browser;
}

/** `scope`: backend profile and user, as the vault's. Registers the key in the background. */
export async function openAgentIdentity(scope: string, client: SupabaseClient, log: (message: string, error?: unknown) => void = console.warn): Promise<AgentSigner> {
    let pair: AgentKeyPair;
    try {
        pair = await scopePair(scope);
    } catch (error) {
        log('[Agent] this browser keeps no IndexedDB: its key for DBMN for VS Code lasts until the tab is closed', error);
        pair = await newAgentKeyPair();
    }
    const signer = await agentSigner(pair, key => registerAgentKey(client, { keyId: key.keyId, publicKey: key.publicKey, label: browserLabel() }));
    // Offline now: VS Code says it doesn't know the key on the first request, and it registers then
    void signer.register?.().catch(error => log('[Agent] could not register this browser\'s key yet', error));
    return signer;
}

/** Sign Out: the key comes off the account and out of this browser. Best effort, never in the way. */
export async function forgetAgentIdentity(scope: string, client: SupabaseClient): Promise<void> {
    try {
        const db = await openDatabase();
        const pair = await done(keys(db, 'readonly').get(scope)) as AgentKeyPair | undefined;
        if (!pair) return;
        await forgetAgentKey(client, (await agentSigner(pair)).keyId);
        await done(keys(db, 'readwrite').delete(scope));
    } catch (error) {
        console.warn('[Agent] could not remove this browser\'s key', error);
    }
}

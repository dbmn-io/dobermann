// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web app's vault (#362): what VS Code keeps in SecretStorage (OAuth client secrets,
 * service-account keys, session and refresh tokens), kept in this browser, encrypted.
 *
 * A browser has no keychain, so this does what the platform offers (OWASP's advice for secrets a
 * page must keep): each secret is encrypted with AES-GCM under a key made by Web Crypto as
 * non-extractable, and both live in IndexedDB. Nothing, our own code included, can read the key
 * out, so a copy of the browser profile or a dump of its storage holds nothing usable; only this
 * origin, in this browser, can decrypt. Each secret is bound to its own name (the AES-GCM
 * additional data), so a ciphertext can't be moved under another name.
 *
 * Nothing secret goes in localStorage. Secrets an earlier version kept there in plain text move
 * here the first time the vault opens (#362). Where IndexedDB is unavailable, secrets stay in this
 * tab's memory and are gone on reload, never written in plain text.
 *
 * The same ISecretStore port as VS Code's SecretStorage and, later, a desktop app's OS keychain.
 */
import type { ISecretStore } from '../../../src/platform/interfaces/secret-store.interface';

const DATABASE = 'dbmn-vault';
const KEYS = 'keys';
const SECRETS = 'secrets';

/** Where an earlier version kept this scope's secrets in plain text. */
const legacyPrefix = (scope: string) => `dbmn-web:${scope}:secret:`;

interface Sealed { iv: Uint8Array; data: ArrayBuffer }

function done<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function openDatabase(): Promise<IDBDatabase> {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
        request.result.createObjectStore(KEYS);
        request.result.createObjectStore(SECRETS);
    };
    return done(request);
}

function store(db: IDBDatabase, name: string, mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(name, mode).objectStore(name);
}

/** This scope's key: made once, never extractable. Two tabs making it at once agree on the first. */
async function scopeKey(db: IDBDatabase, scope: string): Promise<CryptoKey> {
    const existing = await done(store(db, KEYS, 'readonly').get(scope)) as CryptoKey | undefined;
    if (existing) return existing;
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
        await done(store(db, KEYS, 'readwrite').add(made, scope));
        return made;
    } catch {
        return await done(store(db, KEYS, 'readonly').get(scope)) as CryptoKey;   // another tab's came first
    }
}

/** This tab's memory only: for a browser that keeps no IndexedDB. */
export function memoryVault(): ISecretStore {
    const secrets = new Map<string, string>();
    return {
        get: async key => secrets.get(key),
        store: async (key, value) => { secrets.set(key, value); },
        delete: async key => { secrets.delete(key); }
    };
}

export async function openBrowserVault(scope: string, log: (message: string, error?: unknown) => void = console.warn): Promise<ISecretStore> {
    let db: IDBDatabase;
    let key: CryptoKey;
    try {
        db = await openDatabase();
        key = await scopeKey(db, scope);
    } catch (error) {
        log('[Vault] this browser keeps no IndexedDB: secrets last until the tab is closed', error);
        const vault = memoryVault();
        await moveLegacySecrets(scope, vault, log);
        return vault;
    }

    const id = (name: string) => `${scope}:${name}`;
    const name = (secret: string) => new TextEncoder().encode(id(secret));

    const vault: ISecretStore = {
        async get(secret) {
            const sealed = await done(store(db, SECRETS, 'readonly').get(id(secret))) as Sealed | undefined;
            if (!sealed) return undefined;
            try {
                const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: name(secret) }, key, sealed.data);
                return new TextDecoder().decode(plain);
            } catch (error) {
                // Sealed under a key this browser no longer has: unreadable, so it goes
                log(`[Vault] could not decrypt ${secret}: removed`, error);
                await done(store(db, SECRETS, 'readwrite').delete(id(secret)));
                return undefined;
            }
        },
        async store(secret, value) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: name(secret) }, key, new TextEncoder().encode(value));
            await done(store(db, SECRETS, 'readwrite').put({ iv, data } satisfies Sealed, id(secret)));
        },
        async delete(secret) {
            await done(store(db, SECRETS, 'readwrite').delete(id(secret)));
        }
    };
    await moveLegacySecrets(scope, vault, log);
    return vault;
}

/** Secrets an earlier version kept in plain localStorage: into the vault, then gone from there. */
async function moveLegacySecrets(scope: string, vault: ISecretStore, log: (message: string, error?: unknown) => void): Promise<void> {
    let keys: string[];
    try {
        keys = Object.keys(localStorage).filter(k => k.startsWith(legacyPrefix(scope)));
    } catch {
        return;   // storage blocked: nothing was kept there either
    }
    for (const legacy of keys) {
        try {
            const value = JSON.parse(localStorage.getItem(legacy) ?? 'null') as unknown;
            const secret = legacy.slice(legacyPrefix(scope).length);
            if (typeof value === 'string' && value && !(await vault.get(secret))) await vault.store(secret, value);
            localStorage.removeItem(legacy);
        } catch (error) {
            log(`[Vault] could not move ${legacy} out of localStorage`, error);
        }
    }
}

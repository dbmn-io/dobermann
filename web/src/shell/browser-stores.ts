// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The browser's device state for the catalogue (core CatalogueState's port, #342): in this
 * browser's localStorage, per backend and user (`scope`); nothing here leaves the browser.
 * Secrets never go here: they're the vault's (browser-vault.ts, #362).
 */
import type { IKeyValueStore } from '../../../src/platform/interfaces/key-value-store.interface';

function read<T>(key: string): T | undefined {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : undefined;
    } catch {
        return undefined;
    }
}

function write(key: string, value: unknown): void {
    try {
        if (value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage blocked (private window): this device's state just isn't remembered
    }
}

/** Device state: what VS Code keeps in globalState. */
export function browserDeviceStore(scope: string): Pick<IKeyValueStore, 'get' | 'update'> {
    const key = (k: string) => `dbmn-web:${scope}:${k}`;
    return {
        get: (<T>(k: string, defaultValue?: T) => read<T>(key(k)) ?? defaultValue) as IKeyValueStore['get'],
        update: async (k: string, value: unknown) => write(key(k), value)
    };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #342: the StoreContext the catalogue managers are built with in VS Code. It forwards to a
 * target that can change: the extension's local store (globalState + SecretStorage) until the
 * user's shared catalogue has loaded after DBMN sign-in, then the CatalogueState; back to the
 * device's on sign-out (its catalogue hidden once moved, see withoutDeviceCatalogue). The managers read their store on every call, so every
 * holder of them sees the switch at once.
 */
import type { StoreContext } from '../../platform/interfaces/store-context.interface';
import { MemoryKeyValueStore } from '../../platform/memory/memory-key-value-store';
import { CATALOGUE_KEYS } from './catalogue-state';

export class SwitchableStoreContext implements StoreContext {
    private target: StoreContext;

    readonly globalState: StoreContext['globalState'] = {
        get: ((key: string, defaultValue?: unknown) => this.target.globalState.get(key, defaultValue)) as StoreContext['globalState']['get'],
        update: (key: string, value: unknown) => this.target.globalState.update(key, value)
    };

    readonly secrets: StoreContext['secrets'] = {
        get: (key: string) => this.target.secrets.get(key),
        store: (key: string, value: string) => this.target.secrets.store(key, value),
        delete: (key: string) => this.target.secrets.delete(key)
    };

    /** The current store's run counters (#366): the account's while signed in. */
    get runCounters(): StoreContext['runCounters'] {
        return this.target.runCounters;
    }

    constructor(private readonly local: StoreContext) {
        this.target = local;
    }

    /** Use this store from now on. */
    switchTo(target: StoreContext): void {
        this.target = target;
    }

    /** Back to the device's own store. */
    switchToLocal(): void {
        this.target = this.local;
    }

    get isLocal(): boolean {
        return this.target === this.local;
    }

    /** The device's own store, whatever is current (for the one-time upload and its backup). */
    get localStore(): StoreContext {
        return this.local;
    }
}

/**
 * The device's store with its catalogue hidden: for the new version signed out, once this
 * device's catalogue has moved to the account. The device's own collections are left for older
 * versions; reads here see none, and writes stay in memory (never stranded on the device). Every
 * other key, and the vault, are the device's.
 */
export function withoutDeviceCatalogue(local: StoreContext): StoreContext {
    const catalogue = new MemoryKeyValueStore();
    return {
        globalState: {
            get: ((key: string, defaultValue?: unknown) => CATALOGUE_KEYS[key]
                ? catalogue.get(key, defaultValue)
                : local.globalState.get(key, defaultValue)) as StoreContext['globalState']['get'],
            update: (key: string, value: unknown) => CATALOGUE_KEYS[key]
                ? catalogue.update(key, value)
                : local.globalState.update(key, value)
        },
        secrets: local.secrets
    };
}

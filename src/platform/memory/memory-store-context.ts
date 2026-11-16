// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** `StoreContext` in memory, for `test:core`: the catalogue managers with no host behind them. */
import type { StoreContext } from '../interfaces/store-context.interface';
import { MemoryKeyValueStore } from './memory-key-value-store';

export function memoryStoreContext(initial: Record<string, unknown> = {}): StoreContext & { secretValues: Map<string, string> } {
    const secretValues = new Map<string, string>();
    return {
        globalState: new MemoryKeyValueStore(initial),
        secretValues,
        secrets: {
            get: async key => secretValues.get(key),
            store: async (key, value) => { secretValues.set(key, value); },
            delete: async key => { secretValues.delete(key); }
        }
    };
}

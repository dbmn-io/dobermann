// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #319: `IKeyValueStore` in memory, for `test:core`. Values are copied in and out, as a real store would. */
import { IKeyValueStore } from '../interfaces/key-value-store.interface';

export class MemoryKeyValueStore implements IKeyValueStore {
    private readonly values = new Map<string, string>();

    constructor(initial: Record<string, unknown> = {}) {
        for (const [key, value] of Object.entries(initial)) {
            this.values.set(key, JSON.stringify(value));
        }
    }

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        const raw = this.values.get(key);
        return raw === undefined ? defaultValue : JSON.parse(raw) as T;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, JSON.stringify(value));
        }
    }

    keys(): readonly string[] {
        return [...this.values.keys()];
    }
}

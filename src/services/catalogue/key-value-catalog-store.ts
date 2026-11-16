// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #339: a `CatalogStore` kept in any `IKeyValueStore`. In VS Code that is `globalState`
 * (the "keep catalogue local only" option, #342); in `test:core` it is memory. One process, so
 * versions and counters are plain read-modify-write here; the Supabase store (#341) makes them
 * atomic across devices.
 */
import { EventEmitter } from '../../platform/events';
import { IKeyValueStore } from '../../platform/interfaces/key-value-store.interface';
import { CatalogChange, CatalogCollection, CatalogConflictError, CatalogStore, SequenceDraw } from './catalog-store.interface';
import { CatalogueConsoleViews, CatalogueEndpoint, CatalogueEnvironment, CatalogueKind, CatalogueSystem, Versioned } from './catalogue.types';

/** Storage keys. New keys, not the legacy `apiEndpoints` / `apiSystems` / `environments` ones (#342 migrates). */
export const CATALOGUE_KEYS = {
    endpoints: 'dbmnCatalogue.endpoints',
    systems: 'dbmnCatalogue.systems',
    environments: 'dbmnCatalogue.environments',
    views: 'dbmnCatalogue.views',
    sequences: 'dbmnCatalogue.sequences'
} as const;

interface SequenceCounters {
    own: number;
    arrays: Record<string, number>;
}

class KeyValueCollection<T extends { id: string }> implements CatalogCollection<T> {
    constructor(
        private readonly store: IKeyValueStore,
        private readonly kind: CatalogueKind,
        private readonly changed: EventEmitter<CatalogChange>
    ) {}

    private read(): Record<string, Versioned<T>> {
        return this.store.get<Record<string, Versioned<T>>>(CATALOGUE_KEYS[this.kind], {});
    }

    async list(): Promise<Versioned<T>[]> {
        return Object.values(this.read());
    }

    async get(id: string): Promise<Versioned<T> | undefined> {
        return this.read()[id];
    }

    async save(item: T, expectedVersion?: number): Promise<Versioned<T>> {
        const all = this.read();
        const current = all[item.id];
        if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
            throw new CatalogConflictError(this.kind, item.id, expectedVersion, current?.version);
        }
        const saved: Versioned<T> = { item, version: (current?.version ?? 0) + 1, updatedAt: Date.now() };
        await this.store.update(CATALOGUE_KEYS[this.kind], { ...all, [item.id]: saved });
        this.changed.fire({ kind: this.kind, id: item.id, deleted: false, version: saved.version });
        return saved;
    }

    async delete(id: string, expectedVersion?: number): Promise<boolean> {
        const all = this.read();
        const current = all[id];
        if (!current) {
            return false;
        }
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new CatalogConflictError(this.kind, id, expectedVersion, current.version);
        }
        const rest = { ...all };
        delete rest[id];
        await this.store.update(CATALOGUE_KEYS[this.kind], rest);
        this.changed.fire({ kind: this.kind, id, deleted: true, version: current.version });
        return true;
    }
}

export class KeyValueCatalogStore implements CatalogStore {
    private readonly changed = new EventEmitter<CatalogChange>();
    readonly onChanged = this.changed.event;
    readonly endpoints: CatalogCollection<CatalogueEndpoint>;
    readonly systems: CatalogCollection<CatalogueSystem>;
    readonly environments: CatalogCollection<CatalogueEnvironment>;
    readonly views: CatalogCollection<CatalogueConsoleViews>;

    constructor(private readonly store: IKeyValueStore) {
        this.endpoints = new KeyValueCollection<CatalogueEndpoint>(store, 'endpoints', this.changed);
        this.systems = new KeyValueCollection<CatalogueSystem>(store, 'systems', this.changed);
        this.views = new KeyValueCollection<CatalogueConsoleViews>(store, 'views', this.changed);
        this.environments = new KeyValueCollection<CatalogueEnvironment>(store, 'environments', this.changed);
    }

    async nextSequence(endpointId: string, arrayPath?: string, options: SequenceDraw = {}): Promise<number> {
        const count = options.count ?? 1;
        const after = options.after ?? 0;
        const all = this.store.get<Record<string, SequenceCounters>>(CATALOGUE_KEYS.sequences, {});
        const counters = all[endpointId] ?? { own: 0, arrays: {} };
        let next: number;
        if (arrayPath === undefined) {
            next = Math.max(counters.own, after) + count;
            counters.own = next;
        } else {
            next = Math.max(counters.arrays[arrayPath] ?? 0, after) + count;
            counters.arrays = { ...counters.arrays, [arrayPath]: next };
        }
        await this.store.update(CATALOGUE_KEYS.sequences, { ...all, [endpointId]: counters });
        return next;
    }

    async returnSequence(endpointId: string, arrayPath: string | undefined, reservedTo: number, usedTo: number): Promise<boolean> {
        const all = this.store.get<Record<string, SequenceCounters>>(CATALOGUE_KEYS.sequences, {});
        const counters = all[endpointId];
        if (!counters || usedTo < 0 || usedTo >= reservedTo) return false;
        const current = arrayPath === undefined ? counters.own : counters.arrays[arrayPath];
        if (current !== reservedTo) return false;
        const updated = arrayPath === undefined
            ? { ...counters, own: usedTo }
            : { ...counters, arrays: { ...counters.arrays, [arrayPath]: usedTo } };
        await this.store.update(CATALOGUE_KEYS.sequences, { ...all, [endpointId]: updated });
        return true;
    }

    async resetSequence(endpointId: string, arrayPath?: string): Promise<void> {
        const all = this.store.get<Record<string, SequenceCounters>>(CATALOGUE_KEYS.sequences, {});
        const counters = all[endpointId] ?? { own: 0, arrays: {} };
        if (arrayPath === undefined) {
            counters.own = 0;
        } else {
            counters.arrays = { ...counters.arrays, [arrayPath]: 0 };
        }
        await this.store.update(CATALOGUE_KEYS.sequences, { ...all, [endpointId]: counters });
    }

    async resetArraySequences(endpointId: string): Promise<void> {
        const all = this.store.get<Record<string, SequenceCounters>>(CATALOGUE_KEYS.sequences, {});
        const counters = all[endpointId];
        if (!counters) {
            return;
        }
        await this.store.update(CATALOGUE_KEYS.sequences, { ...all, [endpointId]: { ...counters, arrays: {} } });
    }
}

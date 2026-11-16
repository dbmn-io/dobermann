// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #339: the local CatalogStore, which keeps versions, catches conflicts, emits changes and keeps run counters. */
import { expect } from 'chai';
import { CatalogChange, CatalogConflictError } from '../../../services/catalogue/catalog-store.interface';
import { CatalogueSystem } from '../../../services/catalogue/catalogue.types';
import { KeyValueCatalogStore } from '../../../services/catalogue/key-value-catalog-store';
import { MemoryKeyValueStore } from '../../../platform/memory/memory-key-value-store';

const system = (name: string): CatalogueSystem => ({ id: 'sys-1', name } as CatalogueSystem);

describe('KeyValueCatalogStore (Issue #339)', () => {
    it('saves, versions, lists and deletes, firing a change each time', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const changes: CatalogChange[] = [];
        catalogue.onChanged(change => changes.push(change));

        const first = await catalogue.systems.save(system('WMS'));
        const second = await catalogue.systems.save(system('WMS Prod'), first.version);

        expect([first.version, second.version]).to.deep.equal([1, 2]);
        expect((await catalogue.systems.get('sys-1'))?.item.name).to.equal('WMS Prod');
        expect((await catalogue.systems.list()).map(v => v.item.id)).to.deep.equal(['sys-1']);
        expect(await catalogue.systems.delete('sys-1', 2)).to.equal(true);
        expect(await catalogue.systems.get('sys-1')).to.equal(undefined);
        expect(changes).to.deep.equal([
            { kind: 'systems', id: 'sys-1', deleted: false, version: 1 },
            { kind: 'systems', id: 'sys-1', deleted: false, version: 2 },
            { kind: 'systems', id: 'sys-1', deleted: true, version: 2 }
        ]);
    });

    it('a save naming a stale version is refused: someone changed it elsewhere', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        await catalogue.systems.save(system('WMS'));
        await catalogue.systems.save(system('WMS v2'), 1);

        let conflict: unknown;
        try {
            await catalogue.systems.save(system('My stale edit'), 1);
        } catch (error) {
            conflict = error;
        }
        expect(conflict).to.be.instanceOf(CatalogConflictError);
        expect(conflict).to.include({ kind: 'systems', id: 'sys-1', expectedVersion: 1, actualVersion: 2 });
        expect((await catalogue.systems.get('sys-1'))?.item.name).to.equal('WMS v2');
    });

    it('run counters start at 1, are kept per endpoint and per array path, and reset as #153 does', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());

        expect(await catalogue.nextSequence('ep-1')).to.equal(1);
        expect(await catalogue.nextSequence('ep-1')).to.equal(2);
        expect(await catalogue.nextSequence('ep-2')).to.equal(1);
        expect(await catalogue.nextSequence('ep-1', 'lines[]')).to.equal(1);
        expect(await catalogue.nextSequence('ep-1', 'lines[]')).to.equal(2);
        expect(await catalogue.nextSequence('ep-1', 'parties[]')).to.equal(1);

        await catalogue.resetSequence('ep-1');
        expect(await catalogue.nextSequence('ep-1')).to.equal(1);
        await catalogue.resetSequence('ep-1', 'lines[]');
        expect(await catalogue.nextSequence('ep-1', 'lines[]')).to.equal(1);
        await catalogue.resetArraySequences('ep-1');
        expect(await catalogue.nextSequence('ep-1', 'parties[]')).to.equal(1);
    });

    it('survives a reload: the same store sees what an earlier instance wrote', async () => {
        const kv = new MemoryKeyValueStore();
        await new KeyValueCatalogStore(kv).systems.save(system('WMS'));
        expect((await new KeyValueCatalogStore(kv).systems.get('sys-1'))?.version).to.equal(1);
    });
});

describe('KeyValueCatalogStore: create only (expectedVersion 0)', () => {
    it('creates a new item, and refuses to overwrite one that already has the id', async () => {
        const catalogue = new KeyValueCatalogStore(new MemoryKeyValueStore());
        const created = await catalogue.systems.save(system('WMS'), 0);
        expect(created.version).to.equal(1);

        let conflict: unknown;
        try {
            await catalogue.systems.save(system('Same id, different item'), 0);
        } catch (error) {
            conflict = error;
        }
        expect(conflict).to.be.instanceOf(CatalogConflictError);
        expect((await catalogue.systems.get('sys-1'))?.item.name).to.equal('WMS');
    });
});
